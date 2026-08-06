"""Adapted evaluator kernel for applying patches and grading private tests.

This module performs the evaluator-side workflow:
- Resets the isolated repository to its frozen base commit
- Validates and applies the candidate patch and private test patch
- Runs the fixed test command with a constrained environment
- Produces deterministic evidence and the final resolved decision
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .canonical import canonical_json, sha256_bytes
from .errors import (
    EvaluationError,
    PatchApplyError,
    PatchPolicyError,
    TapParseError,
)
from .patches import GitRepository, reject_path_conflict, validate_patch
from .private_spec import MAX_CANDIDATE_PATCH_BYTES, MAX_PATCH_BYTES, PrivateEvaluationSpec
from .tap import parse_tap

HARNESS_REVISION = "726c5461e2ef52d83cf1ea2107870a8bb3328d57"
ADAPTER_SHA256 = "a8aaaffee376dbbc91e48682d49b334fa617eb1dd38156637cda5809f1d24857"
TEST_COMMAND = (
    "npx",
    "mocha",
    "test/unit/adapters/http.js",
    "-R",
    "tap",
    "-g",
    "compression",
)
MAX_TEST_LOG_BYTES = 32 * 1024 * 1024
MAX_PERSISTED_EVALUATOR_LOG_BYTES = 1024 * 1024


@dataclass(frozen=True)
class ExecutionResult:
    """Immutable outcome captured from one evaluator test process."""

    exit_code: int | None
    timed_out: bool
    duration_ms: int
    log: bytes


class Repository(Protocol):
    """Repository operations required by the evaluation kernel."""

    def reset_and_verify_base(self) -> None:
        """Restore the workspace to the frozen base and verify it is clean."""
        ...

    def apply_candidate(self, patch: bytes) -> None:
        """Apply the untrusted candidate patch to the isolated workspace."""
        ...

    def apply_test_patch(self, patch: bytes) -> None:
        """Apply the evaluator-private test patch after the candidate patch."""
        ...


class Executor(Protocol):
    """Test-process operation required by the evaluation kernel."""

    def execute(
        self,
        command: tuple[str, ...],
        workspace: Path,
        timeout_seconds: int,
    ) -> ExecutionResult:
        """Run the fixed evaluator command and return bounded process evidence."""
        ...


class SubprocessExecutor:
    """Runs the one approved test command inside the evaluator workspace."""

    def execute(self, command: tuple[str, ...], workspace: Path, timeout_seconds: int) -> ExecutionResult:
        """Execute the fixed test command with no stdin and a minimal environment."""

        if command != TEST_COMMAND or workspace.resolve() != Path("/testbed"):
            raise EvaluationError("formal evaluator command or working directory drifted")
        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/tmp/repofixlab-home"),
            "CI": "1",
            "NO_PROXY": "*",
            "no_proxy": "*",
        }
        started = time.monotonic_ns()
        process = subprocess.Popen(
            list(command),
            cwd=workspace,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        timed_out = False
        try:
            output, _ = process.communicate(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
        duration_ms = max(0, (time.monotonic_ns() - started) // 1_000_000)
        if len(output) > MAX_TEST_LOG_BYTES:
            raise EvaluationError("test log exceeds the evaluator evidence limit")
        return ExecutionResult(
            exit_code=None if timed_out else process.returncode,
            timed_out=timed_out,
            duration_ms=duration_ms,
            log=output,
        )


def _confined_existing_file(path: Path, root: Path, label: str) -> Path:
    """Resolve a regular file while rejecting symlinks and root escapes."""

    resolved_root = root.resolve(strict=True)
    if path.is_symlink():
        raise PatchPolicyError(f"{label} must not be a symlink")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise PatchPolicyError(f"{label} is outside its allowed root") from error
    if not resolved.is_file():
        raise PatchPolicyError(f"{label} is not a regular file")
    return resolved


def _read_candidate(path: Path, candidate_root: Path) -> bytes:
    """Read a candidate patch from its allowed root under fixed content limits."""

    resolved = _confined_existing_file(path, candidate_root, "candidate patch")
    descriptor = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        data = os.read(descriptor, MAX_PATCH_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(data) > MAX_PATCH_BYTES or b"\x00" in data:
        raise PatchPolicyError("candidate patch violates size or content policy")
    return data


def _write_log_exclusive(path: Path, evidence_root: Path, content: bytes) -> None:
    """Create a new evaluator log without following links or overwriting evidence."""

    resolved_root = evidence_root.resolve(strict=True)
    resolved_parent = path.parent.resolve(strict=True)
    try:
        resolved_parent.relative_to(resolved_root)
    except ValueError as error:
        raise EvaluationError("test log output is outside the evidence root") from error
    if path.exists() or path.is_symlink():
        raise EvaluationError("test log output already exists")
    descriptor = os.open(
        resolved_parent / path.name,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _persisted_log(log: bytes, maximum_bytes: int | None) -> bytes:
    """Retain a bounded head-and-tail view when a persisted log is too large."""

    if maximum_bytes is None or len(log) <= maximum_bytes:
        return log
    marker = (
        "\n--- REPOFIXLAB EVALUATOR LOG TRUNCATED "
        f"original_bytes={len(log)} retained=head+tail ---\n"
    ).encode("ascii")
    if len(marker) >= maximum_bytes:
        raise EvaluationError("persisted evaluator log limit cannot contain its marker")
    retained_bytes = maximum_bytes - len(marker)
    head_bytes = retained_bytes // 2
    tail_bytes = retained_bytes - head_bytes
    return log[:head_bytes] + marker + log[-tail_bytes:]


def _partition(expected: tuple[str, ...], statuses: dict[str, str]) -> dict[str, list[str]]:
    """Split expected tests into deterministic success and failure lists."""

    success = sorted(name for name in expected if statuses.get(name) in {"passed", "xfailed"})
    failure = sorted(name for name in expected if name not in success)
    return {"success": success, "failure": failure}


def _empty_partition(spec: PrivateEvaluationSpec) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Create fail-closed empty F2P and P2P partitions for an unevaluated report."""

    return (
        {"success": [], "failure": sorted(spec.fail_to_pass)},
        {"success": [], "failure": sorted(spec.pass_to_pass)},
    )


def _report_hash(report: dict[str, object]) -> str:
    """Hash a report using canonical JSON serialization."""

    return sha256_bytes(canonical_json(report))


def _base_report(
    *,
    probe_kind: str,
    spec: PrivateEvaluationSpec,
    official_source_lock_sha256: str,
    pristine_runtime_lock_sha256: str,
    candidate_patch_sha256: str | None,
    test_patch_sha256: str,
) -> dict[str, object]:
    """Create the fail-closed report skeleton used before evaluation succeeds."""

    fail_to_pass, pass_to_pass = _empty_partition(spec)
    return {
        "schema_version": "v1",
        "report_type": "harness_probe",
        "harness_mode": "adapted",
        "probe_kind": probe_kind,
        "instance_id": spec.instance_id,
        "base_commit": spec.base_commit,
        "harness_revision": HARNESS_REVISION,
        "official_source_lock_sha256": official_source_lock_sha256,
        "pristine_runtime_lock_sha256": pristine_runtime_lock_sha256,
        "adapter_sha256": ADAPTER_SHA256,
        "candidate_patch_sha256": candidate_patch_sha256,
        "test_patch_sha256": test_patch_sha256,
        "candidate_patch_apply_status": "not_applicable" if probe_kind == "base" else "error",
        "test_patch_apply_status": "not_run",
        "test_executed": False,
        "test_collected": False,
        "test_status_map": [],
        "collected_tests": [],
        "skipped_tests": [],
        "fail_to_pass": fail_to_pass,
        "pass_to_pass": pass_to_pass,
        "resolved": False,
        "exit_code": None,
        "timed_out": False,
        "duration_ms": 0,
        "test_log_sha256": None,
        "official_report_sha256": None,
        "error_class": None,
    }


class EvaluationKernel:
    """Owns the isolated patch-application, test-execution, and grading sequence."""

    def __init__(
        self,
        workspace: Path,
        candidate_root: Path,
        evidence_root: Path,
        executor: Executor | None = None,
        repository: Repository | None = None,
        timeout_seconds: int = 300,
    ) -> None:
        """Configure evaluator roots, execution adapters, and the time limit."""

        self.workspace = workspace
        self.candidate_root = candidate_root
        self.evidence_root = evidence_root
        self.executor = executor or SubprocessExecutor()
        self.repository = repository or GitRepository(workspace, "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b")
        self.timeout_seconds = timeout_seconds

    def evaluate(
        self,
        *,
        probe_kind: str,
        spec: PrivateEvaluationSpec,
        official_source_lock_sha256: str,
        pristine_runtime_lock_sha256: str,
        candidate_path: Path | None,
        log_output_path: Path,
    ) -> dict[str, object]:
        """Evaluate one harness probe after enforcing probe-specific inputs."""

        if probe_kind not in {"base", "no_op", "malformed", "gold"}:
            raise ValueError("unknown probe kind")
        if len(official_source_lock_sha256) != 64 or any(character not in "0123456789abcdef" for character in official_source_lock_sha256):
            raise ValueError("official source lock SHA-256 is invalid")
        if len(pristine_runtime_lock_sha256) != 64 or any(character not in "0123456789abcdef" for character in pristine_runtime_lock_sha256):
            raise ValueError("pristine runtime lock SHA-256 is invalid")
        if probe_kind in {"no_op", "malformed"}:
            if candidate_path is None:
                raise ValueError("probe requires a candidate patch file")
            candidate_patch = _read_candidate(candidate_path, self.candidate_root)
        elif probe_kind == "gold":
            if candidate_path is not None:
                raise ValueError("gold probe may only use evaluator-private gold patch")
            candidate_patch = spec.gold_patch
        else:
            if candidate_path is not None:
                raise ValueError("base probe must not receive a candidate patch")
            candidate_patch = None
        if probe_kind == "no_op" and candidate_patch != b"":
            raise ValueError("no-op probe must use the empty patch")
        return self._evaluate_loaded_patch(
            probe_kind=probe_kind,
            spec=spec,
            official_source_lock_sha256=official_source_lock_sha256,
            pristine_runtime_lock_sha256=pristine_runtime_lock_sha256,
            candidate_patch=candidate_patch,
            log_output_path=log_output_path,
            candidate_patch_max_bytes=MAX_PATCH_BYTES,
            persisted_log_max_bytes=None,
        )

    def evaluate_agent_patch(
        self,
        *,
        spec: PrivateEvaluationSpec,
        candidate_patch: bytes,
        log_output_path: Path,
    ) -> dict[str, object]:
        """Evaluate a submitted agent patch with production evidence limits."""

        return self._evaluate_loaded_patch(
            probe_kind="agent_patch",
            spec=spec,
            official_source_lock_sha256="0" * 64,
            pristine_runtime_lock_sha256="0" * 64,
            candidate_patch=candidate_patch,
            log_output_path=log_output_path,
            candidate_patch_max_bytes=MAX_CANDIDATE_PATCH_BYTES,
            persisted_log_max_bytes=MAX_PERSISTED_EVALUATOR_LOG_BYTES,
        )

    def _evaluate_loaded_patch(
        self,
        *,
        probe_kind: str,
        spec: PrivateEvaluationSpec,
        official_source_lock_sha256: str,
        pristine_runtime_lock_sha256: str,
        candidate_patch: bytes | None,
        log_output_path: Path,
        candidate_patch_max_bytes: int,
        persisted_log_max_bytes: int | None,
    ) -> dict[str, object]:
        """Run the common fail-closed evaluation pipeline for a loaded patch."""

        candidate_hash = None if candidate_patch is None else sha256_bytes(candidate_patch)
        test_patch_hash = sha256_bytes(spec.test_patch)
        report = _base_report(
            probe_kind=probe_kind,
            spec=spec,
            official_source_lock_sha256=official_source_lock_sha256,
            pristine_runtime_lock_sha256=pristine_runtime_lock_sha256,
            candidate_patch_sha256=candidate_hash,
            test_patch_sha256=test_patch_hash,
        )
        try:
            self.repository.reset_and_verify_base()
            test_paths = validate_patch(spec.test_patch, self.workspace, test_patch=True)
            if candidate_patch is not None and candidate_patch:
                try:
                    candidate_paths = validate_patch(
                        candidate_patch,
                        self.workspace,
                        test_patch=False,
                        maximum_bytes=candidate_patch_max_bytes,
                    )
                except PatchPolicyError as error:
                    if probe_kind == "malformed":
                        raise PatchApplyError("malformed probe failed patch application") from error
                    raise
                reject_path_conflict(candidate_paths, test_paths)
                self.repository.apply_candidate(candidate_patch)
            if candidate_patch is not None:
                report["candidate_patch_apply_status"] = "applied"
            self.repository.apply_test_patch(spec.test_patch)
            report["test_patch_apply_status"] = "applied"
            result = self.executor.execute(TEST_COMMAND, self.workspace, self.timeout_seconds)
            persisted_log = _persisted_log(result.log, persisted_log_max_bytes)
            _write_log_exclusive(log_output_path, self.evidence_root, persisted_log)
            report.update(
                {
                    "test_executed": True,
                    "exit_code": result.exit_code,
                    "timed_out": result.timed_out,
                    "duration_ms": result.duration_ms,
                    "test_log_sha256": sha256_bytes(persisted_log),
                }
            )
            parsed = parse_tap(result.log)
            statuses = parsed.status_map
            collected = sorted(statuses)
            skipped = sorted(parsed.skipped_tests)
            fail_to_pass = _partition(spec.fail_to_pass, statuses)
            pass_to_pass = _partition(spec.pass_to_pass, statuses)
            report.update(
                {
                    "test_collected": bool(collected),
                    "test_status_map": [{"name": name, "status": statuses[name]} for name in collected],
                    "collected_tests": collected,
                    "skipped_tests": skipped,
                    "fail_to_pass": fail_to_pass,
                    "pass_to_pass": pass_to_pass,
                }
            )
            targets = set(spec.fail_to_pass) | set(spec.pass_to_pass)
            if result.timed_out:
                report["error_class"] = "test_timeout"
            elif not targets.issubset(statuses):
                report["error_class"] = "target_tests_not_collected"
            elif collected and set(collected) == set(skipped):
                report["error_class"] = "all_tests_skipped"
            elif not collected:
                report["error_class"] = "test_execution_error"
            report["resolved"] = (
                report["error_class"] is None
                and not fail_to_pass["failure"]
                and not pass_to_pass["failure"]
            )
        except TapParseError as error:
            report["error_class"] = error.error_class
        except EvaluationError as error:
            report["error_class"] = error.error_class
            if error.error_class == "patch_apply_error":
                report["candidate_patch_apply_status"] = "error"
            elif error.error_class == "patch_policy_error":
                report["candidate_patch_apply_status"] = "rejected"
            elif error.error_class == "test_patch_policy_error":
                report["test_patch_apply_status"] = "rejected"
            elif error.error_class in {"test_patch_conflict", "test_patch_apply_error"}:
                report["test_patch_apply_status"] = "error"
        except (OSError, subprocess.SubprocessError):
            report["error_class"] = "internal_error"
        finally:
            try:
                self.repository.reset_and_verify_base()
            except (EvaluationError, OSError, subprocess.SubprocessError):
                if report["error_class"] is None:
                    report["error_class"] = "base_state_error"
                    report["resolved"] = False
        report["report_sha256"] = _report_hash(report)
        return report
