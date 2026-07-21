"""Generic M6 candidate execution and pristine official-result finalization.

The task-image phase can execute hidden SWE-bench tests but never decides the
result.  It emits only bounded, non-test-name metadata plus the private test
log.  A separate pristine-harness phase calls the pinned M3 grader and writes
the public final result.  This keeps M6 independent from the Axios-only M1
evaluator without changing the sealed M3 adapter.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Mapping

from .agent_patch import AGENT_PATCH_FILE, read_agent_candidate, validate_agent_identity, validate_candidate_sha256
from .canonical import canonical_json, sha256_bytes
from .m3_task_kernel import (
    MAX_LOG_BYTES,
    M3KernelError,
    _apply_adapted,
    _canonical_json,
    _execute_eval_script,
    _git,
    _load_strict_spec,
    _read_confined,
    _require_identity,
    _reset,
    _sha256,
    grade,
)
from .patches import validate_patch


EVALUATION_FILE = "evaluation.json"
CANDIDATE_RUN_FILE = "candidate-run.json"
OFFICIAL_TEST_LOG_FILE = "official-test.log"
EVALUATOR_LOG_FILE = "evaluator.log"
PATCH_DIAGNOSTICS_FILE = "patch-apply.json"
MAX_CANDIDATE_PATCH_BYTES = 2 * 1024 * 1024
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_REPOSITORY_BY_INSTANCE_OWNER = {
    "axios": "axios/axios",
    "immutable-js": "immutable-js/immutable-js",
    "mrdoob": "mrdoob/three.js",
    "preactjs": "preactjs/preact",
}


class M6CandidatePatchError(RuntimeError):
    """A generic candidate execution cannot safely be completed."""


def repository_for_instance(instance_id: str) -> str:
    """Return the fixed public repository identity for the M6 population."""
    owner, separator, _task = instance_id.partition("__")
    repository = _REPOSITORY_BY_INSTANCE_OWNER.get(owner) if separator else None
    if repository is None:
        raise M6CandidatePatchError("instance is outside the frozen M6 repository population")
    return repository


def _write_exclusive(path: Path, root: Path, content: bytes, mode: int) -> None:
    resolved_root = root.resolve(strict=True)
    if path.is_symlink():
        raise M6CandidatePatchError("M6 output path must not be a symlink")
    parent = path.parent.resolve(strict=True)
    try:
        parent.relative_to(resolved_root)
    except ValueError as error:
        raise M6CandidatePatchError("M6 output escaped its evidence root") from error
    descriptor = os.open(
        parent / path.name,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        mode,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _output_root(path: Path, required: tuple[str, ...]) -> Path:
    if path.is_symlink():
        raise M6CandidatePatchError("M6 evidence root must not be a symlink")
    root = path.resolve(strict=True)
    if not root.is_dir() or any((root / name).exists() or (root / name).is_symlink() for name in required):
        raise M6CandidatePatchError("M6 evidence outputs are unavailable")
    return root


def _execution_report(
    *,
    evaluation_id: str,
    job_id: str,
    run_id: str,
    attempt_id: str,
    instance_id: str,
    base_commit: str,
    candidate_patch_sha256: str,
    candidate_patch_bytes: int | None,
    candidate_patch_apply_status: str,
    test_patch_apply_status: str,
    test_executed: bool,
    exit_code: int | None,
    timed_out: bool,
    duration_ms: int,
    test_log_sha256: str | None,
    error_class: str | None,
) -> dict[str, object]:
    return {
        "schema_version": "v1",
        "record_type": "m6_candidate_execution",
        "evaluation_id": evaluation_id,
        "job_id": job_id,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "instance_id": instance_id,
        "base_commit": base_commit,
        "harness_mode": "adapted",
        "candidate_patch_sha256": candidate_patch_sha256,
        "candidate_patch_bytes": candidate_patch_bytes,
        "candidate_patch_apply_status": candidate_patch_apply_status,
        "test_patch_apply_status": test_patch_apply_status,
        "test_executed": test_executed,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_ms": duration_ms,
        "test_log_sha256": test_log_sha256,
        "error_class": error_class,
    }


def _diagnostics(report: Mapping[str, object]) -> dict[str, object]:
    unsigned = {
        "schema_version": "v1",
        "artifact_type": "m6_patch_apply_diagnostics",
        "evaluation_id": report["evaluation_id"],
        "candidate_patch_sha256": report["candidate_patch_sha256"],
        "candidate_patch_bytes": report["candidate_patch_bytes"],
        "candidate_patch_apply_status": report["candidate_patch_apply_status"],
        "test_patch_apply_status": report["test_patch_apply_status"],
        "test_executed": report["test_executed"],
        "timed_out": report["timed_out"],
        "error_class": report["error_class"],
    }
    return {**unsigned, "diagnostics_sha256": sha256_bytes(canonical_json(unsigned))}


def execute_candidate(
    *,
    private_spec_path: Path,
    private_root: Path,
    workspace: Path,
    candidate_root: Path,
    evidence_root: Path,
    private_spec_sha256: str,
    candidate_patch_sha256: str,
    instance_id: str,
    base_commit: str,
    evaluation_id: str,
    job_id: str,
    run_id: str,
    attempt_id: str,
    timeout_seconds: int,
) -> dict[str, object]:
    for value, label in (
        (evaluation_id, "evaluation_id"),
        (job_id, "job_id"),
        (run_id, "run_id"),
        (attempt_id, "attempt_id"),
    ):
        validate_agent_identity(value, label)
    _require_identity(instance_id, base_commit)
    validate_candidate_sha256(candidate_patch_sha256)
    if _SHA256.fullmatch(private_spec_sha256) is None:
        raise ValueError("M6 prepared private spec SHA-256 is malformed")
    if timeout_seconds < 1 or timeout_seconds > 300:
        raise ValueError("M6 timeout is outside the fixed range")
    root = _output_root(
        evidence_root,
        (CANDIDATE_RUN_FILE, OFFICIAL_TEST_LOG_FILE, EVALUATOR_LOG_FILE, PATCH_DIAGNOSTICS_FILE),
    )
    candidate = read_agent_candidate(candidate_root, candidate_patch_sha256)
    report = _execution_report(
        evaluation_id=evaluation_id,
        job_id=job_id,
        run_id=run_id,
        attempt_id=attempt_id,
        instance_id=instance_id,
        base_commit=base_commit,
        candidate_patch_sha256=candidate_patch_sha256,
        candidate_patch_bytes=candidate.bytes_count,
        candidate_patch_apply_status="error",
        test_patch_apply_status="not_run",
        test_executed=False,
        exit_code=None,
        timed_out=False,
        duration_ms=0,
        test_log_sha256=None,
        error_class="internal_error",
    )
    reset_required = False
    try:
        raw_spec = _read_confined(private_spec_path, private_root, MAX_CANDIDATE_PATCH_BYTES + 512 * 1024)
        if _sha256(raw_spec) != private_spec_sha256:
            raise M6CandidatePatchError("M6 prepared private spec hash drifted")
        spec = _load_strict_spec(private_spec_path, private_root, instance_id, base_commit)
        if candidate.patch is None:
            report["candidate_patch_apply_status"] = "rejected" if candidate.status == "rejected" else "error"
            report["error_class"] = candidate.error_class or "internal_error"
        else:
            _reset(base_commit)
            reset_required = True
            if candidate.patch:
                validate_patch(
                    candidate.patch,
                    workspace,
                    test_patch=False,
                    maximum_bytes=MAX_CANDIDATE_PATCH_BYTES,
                )
                if not _apply_adapted(candidate.patch):
                    report["candidate_patch_apply_status"] = "rejected"
                    report["error_class"] = "patch_apply_error"
                else:
                    report["candidate_patch_apply_status"] = "applied"
            else:
                report["candidate_patch_apply_status"] = "not_applicable"
                report["error_class"] = None
            if report["candidate_patch_apply_status"] in {"applied", "not_applicable"}:
                test_patch = str(spec["test_patch"]).encode("utf-8")
                if _git("apply", "--check", "-", input_bytes=test_patch).returncode != 0:
                    report["test_patch_apply_status"] = "rejected"
                    report["error_class"] = "test_patch_conflict"
                else:
                    report["test_patch_apply_status"] = "applied"
                    exit_code, timed_out, duration_ms, log = _execute_eval_script(
                        private_root / "eval.sh", timeout_seconds
                    )
                    _write_exclusive(root / OFFICIAL_TEST_LOG_FILE, root, log, 0o444)
                    report.update(
                        {
                            "test_executed": True,
                            "exit_code": exit_code,
                            "timed_out": timed_out,
                            "duration_ms": duration_ms,
                            "test_log_sha256": _sha256(log),
                            "error_class": None if not timed_out else "test_timeout",
                        }
                    )
    except (M3KernelError, M6CandidatePatchError, OSError, ValueError):
        if report["error_class"] == "internal_error":
            report["error_class"] = "evaluation_setup_error"
    finally:
        if reset_required:
            try:
                _reset(base_commit)
            except M3KernelError:
                report["error_class"] = "base_state_error"
                report["test_executed"] = False
                report["test_log_sha256"] = None
    terminal = {
        "schema_version": "v1",
        "log_type": "m6_evaluator_terminal",
        "evaluation_id": evaluation_id,
        "test_executed": report["test_executed"],
        "error_class": report["error_class"],
    }
    _write_exclusive(root / EVALUATOR_LOG_FILE, root, _canonical_json(terminal), 0o444)
    _write_exclusive(root / PATCH_DIAGNOSTICS_FILE, root, canonical_json(_diagnostics(report)), 0o444)
    _write_exclusive(root / CANDIDATE_RUN_FILE, root, _canonical_json(report), 0o444)
    return report


def _load_candidate_execution(
    evidence_root: Path,
    *,
    instance_id: str,
    base_commit: str,
) -> dict[str, object]:
    raw = _read_confined(evidence_root / CANDIDATE_RUN_FILE, evidence_root, 64 * 1024)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise M6CandidatePatchError("M6 candidate execution report is invalid") from error
    expected = {
        "schema_version", "record_type", "evaluation_id", "job_id", "run_id", "attempt_id",
        "instance_id", "base_commit", "harness_mode", "candidate_patch_sha256", "candidate_patch_bytes",
        "candidate_patch_apply_status", "test_patch_apply_status", "test_executed", "exit_code",
        "timed_out", "duration_ms", "test_log_sha256", "error_class",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected
        or value["schema_version"] != "v1"
        or value["record_type"] != "m6_candidate_execution"
        or value["instance_id"] != instance_id
        or value["base_commit"] != base_commit
        or value["harness_mode"] != "adapted"
        or not all(isinstance(value[name], str) for name in ("evaluation_id", "job_id", "run_id", "attempt_id"))
        or _SHA256.fullmatch(str(value["candidate_patch_sha256"])) is None
        or (value["candidate_patch_bytes"] is not None and (isinstance(value["candidate_patch_bytes"], bool) or not isinstance(value["candidate_patch_bytes"], int) or value["candidate_patch_bytes"] < 0))
        or value["candidate_patch_apply_status"] not in {"applied", "not_applicable", "rejected", "error"}
        or value["test_patch_apply_status"] not in {"not_run", "applied", "rejected", "error"}
        or not isinstance(value["test_executed"], bool)
        or (value["exit_code"] is not None and (isinstance(value["exit_code"], bool) or not isinstance(value["exit_code"], int)))
        or not isinstance(value["timed_out"], bool)
        or isinstance(value["duration_ms"], bool)
        or not isinstance(value["duration_ms"], int)
        or value["duration_ms"] < 0
        or (value["test_log_sha256"] is not None and _SHA256.fullmatch(str(value["test_log_sha256"])) is None)
        or (value["error_class"] is not None and not isinstance(value["error_class"], str))
    ):
        raise M6CandidatePatchError("M6 candidate execution report violates its contract")
    if value["test_executed"] != (value["test_log_sha256"] is not None):
        raise M6CandidatePatchError("M6 candidate execution log binding is inconsistent")
    return value


def finalize_official_evaluation(
    *,
    private_root: Path,
    evidence_root: Path,
    instance_id: str,
    base_commit: str,
    repo: str,
    source_root: Path,
) -> dict[str, object]:
    _require_identity(instance_id, base_commit)
    root = _output_root(evidence_root, (EVALUATION_FILE,))
    execution = _load_candidate_execution(root, instance_id=instance_id, base_commit=base_commit)
    official_grading: dict[str, object] | None = None
    error_class = execution["error_class"]
    if execution["test_executed"]:
        official_grading = grade(
            private_root=private_root,
            evidence_root=root,
            instance_id=instance_id,
            base_commit=base_commit,
            repo=repo,
            source_root=source_root,
        )
        if official_grading["test_log_sha256"] != execution["test_log_sha256"]:
            raise M6CandidatePatchError("M6 official grade log binding drifted")
    completed = (
        execution["candidate_patch_apply_status"] in {"applied", "not_applicable"}
        and execution["test_patch_apply_status"] == "applied"
        and execution["test_executed"] is True
        and execution["timed_out"] is False
        and error_class is None
        and official_grading is not None
    )
    resolved = completed and bool(official_grading["resolved"])
    unsigned = {
        "schema_version": "v1",
        "result_type": "m6_official_evaluation",
        "evaluation_id": execution["evaluation_id"],
        "job_id": execution["job_id"],
        "run_id": execution["run_id"],
        "attempt_id": execution["attempt_id"],
        "instance_id": instance_id,
        "base_commit": base_commit,
        "harness_mode": "adapted",
        "status": "completed" if completed else "failed",
        "resolved": resolved,
        "candidate_patch_sha256": execution["candidate_patch_sha256"],
        "candidate_patch_apply_status": execution["candidate_patch_apply_status"],
        "test_patch_apply_status": execution["test_patch_apply_status"],
        "test_executed": execution["test_executed"],
        "exit_code": execution["exit_code"],
        "timed_out": execution["timed_out"],
        "duration_ms": execution["duration_ms"],
        "official_grading": official_grading,
        "error_class": error_class,
    }
    result = {**unsigned, "evaluation_sha256": sha256_bytes(canonical_json(unsigned))}
    _write_exclusive(root / EVALUATION_FILE, root, canonical_json(result), 0o600)
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="repofixlab-m6-candidate-patch")
    commands = parser.add_subparsers(dest="command", required=True)
    candidate = commands.add_parser("execute")
    candidate.add_argument("--private-spec", type=Path, required=True)
    candidate.add_argument("--private-root", type=Path, required=True)
    candidate.add_argument("--workspace", type=Path, required=True)
    candidate.add_argument("--candidate-root", type=Path, required=True)
    candidate.add_argument("--evidence-root", type=Path, required=True)
    candidate.add_argument("--private-spec-sha256", required=True)
    candidate.add_argument("--candidate-patch-sha256", required=True)
    candidate.add_argument("--instance-id", required=True)
    candidate.add_argument("--base-commit", required=True)
    candidate.add_argument("--evaluation-id", required=True)
    candidate.add_argument("--job-id", required=True)
    candidate.add_argument("--run-id", required=True)
    candidate.add_argument("--attempt-id", required=True)
    candidate.add_argument("--timeout-seconds", type=int, required=True)
    finalizer = commands.add_parser("finalize")
    finalizer.add_argument("--private-root", type=Path, required=True)
    finalizer.add_argument("--evidence-root", type=Path, required=True)
    finalizer.add_argument("--instance-id", required=True)
    finalizer.add_argument("--base-commit", required=True)
    finalizer.add_argument("--repo", required=True)
    finalizer.add_argument("--source-root", type=Path, default=Path("/opt/upstream"))
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "execute":
            result = execute_candidate(
                private_spec_path=arguments.private_spec,
                private_root=arguments.private_root,
                workspace=arguments.workspace,
                candidate_root=arguments.candidate_root,
                evidence_root=arguments.evidence_root,
                private_spec_sha256=arguments.private_spec_sha256,
                candidate_patch_sha256=arguments.candidate_patch_sha256,
                instance_id=arguments.instance_id,
                base_commit=arguments.base_commit,
                evaluation_id=arguments.evaluation_id,
                job_id=arguments.job_id,
                run_id=arguments.run_id,
                attempt_id=arguments.attempt_id,
                timeout_seconds=arguments.timeout_seconds,
            )
        else:
            result = finalize_official_evaluation(
                private_root=arguments.private_root,
                evidence_root=arguments.evidence_root,
                instance_id=arguments.instance_id,
                base_commit=arguments.base_commit,
                repo=arguments.repo,
                source_root=arguments.source_root,
            )
        sys.stdout.buffer.write(canonical_json(result))
        return 0
    except (M3KernelError, M6CandidatePatchError, OSError, ValueError):
        sys.stderr.write("repofixlab M6 candidate evaluation failed closed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
