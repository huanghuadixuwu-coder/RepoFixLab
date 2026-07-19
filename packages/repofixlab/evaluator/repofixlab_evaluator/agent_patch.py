from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .canonical import canonical_json, sha256_bytes, sha256_file
from .errors import EvaluationError, PatchPolicyError, PrivateSpecError
from .patches import validate_patch
from .private_spec import (
    BASE_COMMIT,
    INSTANCE_ID,
    MAX_CANDIDATE_PATCH_BYTES,
    MAX_PATCH_BYTES,
    PrivateEvaluationSpec,
)
from .runner import HARNESS_REVISION, EvaluationKernel, Executor, Repository

AGENT_PATCH_FILE = "candidate.patch"
EVALUATION_FILE = "evaluation.json"
EVALUATOR_LOG_FILE = "evaluator.log"
PATCH_DIAGNOSTICS_FILE = "patch-apply.json"
PRIVATE_DATASET_TASK_SHA256 = "a592340952c75bf326d9ca45bdef7a2e635dcb5648c674e6a9fae25bae165f50"
DATASET_REVISION = "2b7aced941b4873e9cad3e76abbae93f481d1beb"
MAX_PRIVATE_TASK_BYTES = 64 * 1024

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class CandidateInput:
    patch: bytes | None
    bytes_count: int | None
    hash_verified: bool
    status: str
    code: str
    error_class: str | None


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_agent_identity(value: str, label: str) -> str:
    if _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(f"{label} is not a strict v1 identifier")
    return value


def validate_candidate_sha256(value: str) -> str:
    if _SHA256.fullmatch(value) is None:
        raise ValueError("candidate patch SHA-256 is invalid")
    return value


def _read_bounded(descriptor: int) -> bytes:
    chunks: list[bytes] = []
    remaining = MAX_CANDIDATE_PATCH_BYTES + 1
    while remaining > 0:
        chunk = os.read(descriptor, min(64 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_agent_candidate(candidate_root: Path, expected_sha256: str) -> CandidateInput:
    validate_candidate_sha256(expected_sha256)
    try:
        if candidate_root.is_symlink():
            return CandidateInput(None, None, False, "rejected", "candidate_root_symlink", "patch_policy_error")
        root = candidate_root.resolve(strict=True)
        if not root.is_dir():
            return CandidateInput(None, None, False, "rejected", "candidate_root_invalid", "patch_policy_error")
        candidate = root / AGENT_PATCH_FILE
        if candidate.is_symlink():
            return CandidateInput(None, None, False, "rejected", "candidate_symlink", "patch_policy_error")
        resolved = candidate.resolve(strict=True)
        try:
            resolved.relative_to(root)
        except ValueError:
            return CandidateInput(None, None, False, "rejected", "candidate_path_escape", "patch_policy_error")
        descriptor = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                return CandidateInput(None, None, False, "rejected", "candidate_not_regular", "patch_policy_error")
            if before.st_size > MAX_CANDIDATE_PATCH_BYTES:
                return CandidateInput(
                    None,
                    before.st_size,
                    False,
                    "rejected",
                    "candidate_too_large",
                    "patch_policy_error",
                )
            patch = _read_bounded(descriptor)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        if len(patch) > MAX_CANDIDATE_PATCH_BYTES:
            return CandidateInput(
                None,
                len(patch),
                False,
                "rejected",
                "candidate_too_large",
                "patch_policy_error",
            )
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_size != len(patch)
        ):
            return CandidateInput(None, len(patch), False, "error", "candidate_changed", "internal_error")
        if b"\x00" in patch:
            return CandidateInput(
                None,
                len(patch),
                False,
                "rejected",
                "candidate_contains_nul",
                "patch_policy_error",
            )
        try:
            patch.decode("utf-8")
        except UnicodeDecodeError:
            return CandidateInput(
                None,
                len(patch),
                False,
                "rejected",
                "candidate_invalid_utf8",
                "patch_policy_error",
            )
        if sha256_bytes(patch) != expected_sha256:
            return CandidateInput(
                None,
                len(patch),
                False,
                "rejected",
                "candidate_hash_mismatch",
                "candidate_patch_integrity_error",
            )
        return CandidateInput(patch, len(patch), True, "accepted", "candidate_accepted", None)
    except (FileNotFoundError, NotADirectoryError):
        return CandidateInput(None, None, False, "rejected", "candidate_missing", "patch_policy_error")
    except OSError:
        return CandidateInput(None, None, False, "error", "candidate_read_error", "internal_error")


def _strict_test_names(value: object, label: str, *, allow_empty: bool) -> tuple[str, ...]:
    if not isinstance(value, list) or (not allow_empty and not value):
        raise PrivateSpecError(f"{label} is not a valid test list")
    if any(not isinstance(name, str) or not name or len(name) > 1000 for name in value):
        raise PrivateSpecError(f"{label} contains an invalid test name")
    names = tuple(value)
    if len(set(names)) != len(names):
        raise PrivateSpecError(f"{label} contains duplicate test names")
    return names


def _strict_patch(value: object, label: str) -> bytes:
    if not isinstance(value, str):
        raise PrivateSpecError(f"{label} is not UTF-8 text")
    patch = value.encode("utf-8")
    if not patch or len(patch) > MAX_PATCH_BYTES or b"\x00" in patch:
        raise PrivateSpecError(f"{label} violates patch policy")
    return patch


def load_agent_private_spec(
    path: Path,
    private_root: Path,
    expected_sha256: str,
) -> PrivateEvaluationSpec:
    validate_candidate_sha256(expected_sha256)
    if expected_sha256 != PRIVATE_DATASET_TASK_SHA256:
        raise PrivateSpecError("private task hash is not the frozen Axios task hash")
    if private_root.is_symlink():
        raise PrivateSpecError("private task root must not be a symlink")
    root = private_root.resolve(strict=True)
    if not root.is_dir() or path.is_symlink():
        raise PrivateSpecError("private task violates root or path policy")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise PrivateSpecError("private task escaped its evaluator-only root") from error
    descriptor = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_PRIVATE_TASK_BYTES:
            raise PrivateSpecError("private task violates type or size policy")
        chunks: list[bytes] = []
        remaining = MAX_PRIVATE_TASK_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(16 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if (
        len(raw) > MAX_PRIVATE_TASK_BYTES
        or before.st_dev != after.st_dev
        or before.st_ino != after.st_ino
        or before.st_size != after.st_size
        or before.st_size != len(raw)
    ):
        raise PrivateSpecError("private task changed or exceeded its read limit")
    if sha256_bytes(raw) != expected_sha256:
        raise PrivateSpecError("private task hash mismatches its sealed binding")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PrivateSpecError("private task is not strict UTF-8 JSON") from error
    required = {
        "schema_version",
        "record_type",
        "dataset_revision",
        "instance_id",
        "gold_patch",
        "test_patch",
        "fail_to_pass",
        "pass_to_pass",
        "harness_parameters",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise PrivateSpecError("private task fields do not match the sealed v1 contract")
    harness = value["harness_parameters"]
    if (
        value["schema_version"] != "v1"
        or value["record_type"] != "private_evaluation_spec"
        or value["dataset_revision"] != DATASET_REVISION
        or value["instance_id"] != INSTANCE_ID
        or not isinstance(harness, dict)
        or set(harness)
        != {
            "dataset_name",
            "dataset_revision",
            "repo",
            "base_commit",
            "version",
            "environment_setup_commit",
        }
        or harness["dataset_name"] != "SWE-bench/SWE-bench_Multilingual"
        or harness["dataset_revision"] != DATASET_REVISION
        or harness["repo"] != "axios/axios"
        or harness["base_commit"] != BASE_COMMIT
        or harness["version"] != "5892"
        or (
            harness["environment_setup_commit"] is not None
            and not isinstance(harness["environment_setup_commit"], str)
        )
    ):
        raise PrivateSpecError("private task identity or harness parameters drifted")
    fail_to_pass = _strict_test_names(value["fail_to_pass"], "fail_to_pass", allow_empty=False)
    pass_to_pass = _strict_test_names(value["pass_to_pass"], "pass_to_pass", allow_empty=True)
    if set(fail_to_pass) & set(pass_to_pass):
        raise PrivateSpecError("private task F2P and P2P sets overlap")
    return PrivateEvaluationSpec(
        instance_id=INSTANCE_ID,
        base_commit=BASE_COMMIT,
        test_patch=_strict_patch(value["test_patch"], "test_patch"),
        gold_patch=_strict_patch(value["gold_patch"], "gold_patch"),
        fail_to_pass=fail_to_pass,
        pass_to_pass=pass_to_pass,
    )


def _empty_partition(spec: PrivateEvaluationSpec | None) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    return (
        {
            "success": [],
            "failure": [] if spec is None else sorted(spec.fail_to_pass),
        },
        {
            "success": [],
            "failure": [] if spec is None else sorted(spec.pass_to_pass),
        },
    )


def _base_evaluation(
    *,
    evaluation_id: str,
    job_id: str,
    run_id: str,
    attempt_id: str,
    candidate_patch_sha256: str,
    candidate_patch_apply_status: str,
    error_class: str,
    spec: PrivateEvaluationSpec | None,
) -> dict[str, object]:
    fail_to_pass, pass_to_pass = _empty_partition(spec)
    return {
        "schema_version": "v1",
        "result_type": "evaluation",
        "evaluation_id": evaluation_id,
        "job_id": job_id,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "instance_id": INSTANCE_ID if spec is None else spec.instance_id,
        "harness_mode": "adapted",
        "harness_revision": HARNESS_REVISION,
        "status": "failed",
        "resolved": False,
        "candidate_patch_sha256": candidate_patch_sha256,
        "candidate_patch_apply_status": candidate_patch_apply_status,
        "test_patch_apply_status": "not_run",
        "test_executed": False,
        "test_collected": False,
        "fail_to_pass": fail_to_pass,
        "pass_to_pass": pass_to_pass,
        "exit_code": None,
        "timed_out": False,
        "duration_ms": 0,
        "test_log": None,
        "official_report_sha256": None,
        "error_class": error_class,
    }


def _from_kernel_report(
    *,
    report: dict[str, object],
    evaluation_id: str,
    job_id: str,
    run_id: str,
    attempt_id: str,
    candidate_patch_sha256: str,
) -> dict[str, object]:
    candidate_status = str(report["candidate_patch_apply_status"])
    test_patch_status = str(report["test_patch_apply_status"])
    test_executed = bool(report["test_executed"])
    timed_out = bool(report["timed_out"])
    error_class = report["error_class"]
    completed = (
        candidate_status == "applied"
        and test_patch_status == "applied"
        and test_executed
        and not timed_out
        and error_class is None
    )
    exit_code = report["exit_code"]
    resolved = bool(report["resolved"]) and completed and exit_code == 0
    return {
        "schema_version": "v1",
        "result_type": "evaluation",
        "evaluation_id": evaluation_id,
        "job_id": job_id,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "instance_id": report["instance_id"],
        "harness_mode": "adapted",
        "harness_revision": HARNESS_REVISION,
        "status": "completed" if completed else "failed",
        "resolved": resolved,
        "candidate_patch_sha256": candidate_patch_sha256,
        "candidate_patch_apply_status": candidate_status,
        "test_patch_apply_status": test_patch_status,
        "test_executed": test_executed,
        "test_collected": bool(report["test_collected"]),
        "fail_to_pass": report["fail_to_pass"],
        "pass_to_pass": report["pass_to_pass"],
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_ms": report["duration_ms"],
        "test_log": None,
        "official_report_sha256": None,
        "error_class": error_class,
    }


def _stage(status: str, code: str) -> dict[str, str]:
    return {"status": status, "code": code}


def _diagnostics(
    *,
    evaluation_id: str,
    candidate_patch_sha256: str,
    candidate_input: CandidateInput,
    candidate_paths: tuple[str, ...],
    evaluation: dict[str, object],
    policy_status: str,
    policy_code: str,
) -> dict[str, object]:
    candidate_status = str(evaluation["candidate_patch_apply_status"])
    test_patch_status = str(evaluation["test_patch_apply_status"])
    test_executed = bool(evaluation["test_executed"])
    timed_out = bool(evaluation["timed_out"])
    if not test_executed:
        harness_stage = _stage("not_run", str(evaluation["error_class"] or "not_run"))
    elif timed_out:
        harness_stage = _stage("timeout", "test_timeout")
    elif evaluation["status"] == "completed":
        harness_stage = _stage(
            "completed",
            "official_resolved" if evaluation["resolved"] else "official_unresolved",
        )
    else:
        harness_stage = _stage("error", str(evaluation["error_class"] or "test_execution_error"))
    if policy_status != "accepted":
        candidate_apply_stage = _stage("not_run", policy_code)
    elif candidate_status == "applied":
        candidate_apply_stage = _stage(
            "applied",
            "empty_patch_noop" if candidate_input.bytes_count == 0 else "candidate_applied",
        )
    else:
        candidate_apply_stage = _stage(candidate_status, str(evaluation["error_class"] or candidate_status))
    if candidate_status != "applied":
        test_patch_apply_stage = _stage("not_run", "candidate_not_applied")
    elif test_patch_status == "applied":
        test_patch_apply_stage = _stage("applied", "test_patch_applied")
    else:
        test_patch_apply_stage = _stage(
            test_patch_status,
            str(evaluation["error_class"] or test_patch_status),
        )
    unsigned: dict[str, object] = {
        "schema_version": "v1",
        "artifact_type": "patch_apply_diagnostics",
        "evaluation_id": evaluation_id,
        "candidate_patch_sha256": candidate_patch_sha256,
        "candidate_patch_bytes": candidate_input.bytes_count,
        "candidate_hash_verified": candidate_input.hash_verified,
        "candidate_paths": list(candidate_paths),
        "stages": {
            "input": _stage(candidate_input.status, candidate_input.code),
            "policy": _stage(policy_status, policy_code),
            "candidate_apply": candidate_apply_stage,
            "test_patch_apply": test_patch_apply_stage,
            "harness": harness_stage,
        },
        "error_class": evaluation["error_class"],
    }
    return {**unsigned, "diagnostics_sha256": sha256_bytes(canonical_json(unsigned))}


def _write_exclusive(path: Path, root: Path, content: bytes) -> None:
    resolved_root = root.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    try:
        parent.relative_to(resolved_root)
    except ValueError as error:
        raise EvaluationError("agent patch output escaped the evidence root") from error
    descriptor = os.open(
        parent / path.name,
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


def _output_paths(evidence_root: Path) -> tuple[Path, Path, Path]:
    if evidence_root.is_symlink():
        raise EvaluationError("agent patch evidence root must not be a symlink")
    root = evidence_root.resolve(strict=True)
    if not root.is_dir():
        raise EvaluationError("agent patch evidence root is not a directory")
    paths = (
        root / EVALUATION_FILE,
        root / EVALUATOR_LOG_FILE,
        root / PATCH_DIAGNOSTICS_FILE,
    )
    if any(path.exists() or path.is_symlink() for path in paths):
        raise EvaluationError("agent patch evidence output already exists")
    return paths


def evaluate_agent_patch(
    *,
    private_spec_path: Path,
    private_root: Path,
    workspace: Path,
    candidate_root: Path,
    evidence_root: Path,
    candidate_patch_sha256: str,
    private_spec_sha256: str,
    evaluation_id: str,
    job_id: str,
    run_id: str,
    attempt_id: str,
    timeout_seconds: int,
    executor: Executor | None = None,
    repository: Repository | None = None,
    finished_at: str | None = None,
) -> dict[str, object]:
    for value, label in (
        (evaluation_id, "evaluation_id"),
        (job_id, "job_id"),
        (run_id, "run_id"),
        (attempt_id, "attempt_id"),
    ):
        validate_agent_identity(value, label)
    validate_candidate_sha256(candidate_patch_sha256)
    validate_candidate_sha256(private_spec_sha256)
    if timeout_seconds < 1 or timeout_seconds > 300:
        raise ValueError("timeout seconds is outside the evaluator limit")
    evaluation_path, evaluator_log_path, diagnostics_path = _output_paths(evidence_root)
    candidate_input = read_agent_candidate(candidate_root, candidate_patch_sha256)
    spec: PrivateEvaluationSpec | None = None
    candidate_paths: tuple[str, ...] = ()
    policy_status = "not_run"
    policy_code = "not_run"
    try:
        spec = load_agent_private_spec(private_spec_path, private_root, private_spec_sha256)
    except EvaluationError as error:
        evaluation = _base_evaluation(
            evaluation_id=evaluation_id,
            job_id=job_id,
            run_id=run_id,
            attempt_id=attempt_id,
            candidate_patch_sha256=candidate_patch_sha256,
            candidate_patch_apply_status="error",
            error_class=error.error_class,
            spec=None,
        )
    except OSError:
        evaluation = _base_evaluation(
            evaluation_id=evaluation_id,
            job_id=job_id,
            run_id=run_id,
            attempt_id=attempt_id,
            candidate_patch_sha256=candidate_patch_sha256,
            candidate_patch_apply_status="error",
            error_class="internal_error",
            spec=None,
        )
    else:
        if candidate_input.patch is None:
            evaluation = _base_evaluation(
                evaluation_id=evaluation_id,
                job_id=job_id,
                run_id=run_id,
                attempt_id=attempt_id,
                candidate_patch_sha256=candidate_patch_sha256,
                candidate_patch_apply_status=(
                    "rejected" if candidate_input.status == "rejected" else "error"
                ),
                error_class=candidate_input.error_class or "internal_error",
                spec=spec,
            )
        else:
            if not candidate_input.patch:
                policy_status = "accepted"
                policy_code = "empty_patch_noop"
            else:
                try:
                    paths = validate_patch(
                        candidate_input.patch,
                        workspace,
                        test_patch=False,
                        maximum_bytes=MAX_CANDIDATE_PATCH_BYTES,
                    )
                    candidate_paths = tuple(sorted(paths))
                    policy_status = "accepted"
                    policy_code = "patch_policy_accepted"
                except PatchPolicyError as error:
                    policy_status = "rejected"
                    policy_code = "patch_policy_rejected"
                    evaluation = _base_evaluation(
                        evaluation_id=evaluation_id,
                        job_id=job_id,
                        run_id=run_id,
                        attempt_id=attempt_id,
                        candidate_patch_sha256=candidate_patch_sha256,
                        candidate_patch_apply_status="rejected",
                        error_class=error.error_class,
                        spec=spec,
                    )
                except OSError:
                    policy_status = "error"
                    policy_code = "patch_policy_error"
                    evaluation = _base_evaluation(
                        evaluation_id=evaluation_id,
                        job_id=job_id,
                        run_id=run_id,
                        attempt_id=attempt_id,
                        candidate_patch_sha256=candidate_patch_sha256,
                        candidate_patch_apply_status="error",
                        error_class="internal_error",
                        spec=spec,
                    )
            if policy_status == "accepted":
                kernel = EvaluationKernel(
                    workspace=workspace,
                    candidate_root=candidate_root,
                    evidence_root=evidence_root,
                    executor=executor,
                    repository=repository,
                    timeout_seconds=timeout_seconds,
                )
                kernel_report = kernel.evaluate_agent_patch(
                    spec=spec,
                    candidate_patch=candidate_input.patch,
                    log_output_path=evaluator_log_path,
                )
                evaluation = _from_kernel_report(
                    report=kernel_report,
                    evaluation_id=evaluation_id,
                    job_id=job_id,
                    run_id=run_id,
                    attempt_id=attempt_id,
                    candidate_patch_sha256=candidate_patch_sha256,
                )
    if not evaluator_log_path.exists():
        terminal_log = canonical_json(
            {
                "schema_version": "v1",
                "log_type": "evaluator_terminal",
                "evaluation_id": evaluation_id,
                "test_executed": evaluation["test_executed"],
                "error_class": evaluation["error_class"],
            }
        )
        _write_exclusive(evaluator_log_path, evidence_root, terminal_log)
    if evaluation["test_executed"]:
        evaluation["test_log"] = {
            "path": EVALUATOR_LOG_FILE,
            "bytes": evaluator_log_path.stat().st_size,
            "sha256": sha256_file(str(evaluator_log_path)),
        }
    timestamp = finished_at or _utc_timestamp()
    evaluation["finished_at"] = timestamp
    evaluation["evaluation_sha256"] = sha256_bytes(canonical_json(evaluation))
    diagnostics = _diagnostics(
        evaluation_id=evaluation_id,
        candidate_patch_sha256=candidate_patch_sha256,
        candidate_input=candidate_input,
        candidate_paths=candidate_paths,
        evaluation=evaluation,
        policy_status=policy_status,
        policy_code=policy_code,
    )
    _write_exclusive(diagnostics_path, evidence_root, canonical_json(diagnostics))
    _write_exclusive(evaluation_path, evidence_root, canonical_json(evaluation))
    return evaluation
