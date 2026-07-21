from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .canonical import canonical_json, sha256_bytes
from .errors import EvaluationError, PatchPolicyError
from .patches import reject_path_conflict, validate_patch
from .private_spec import MAX_PATCH_BYTES, PrivateEvaluationSpec, TaskIdentity, load_private_spec

WORKSPACE = Path("/testbed")
MAX_LOG_BYTES = 32 * 1024 * 1024
OFFICIAL_APPLY_COMMANDS = (
    ("git", "apply", "--verbose"),
    ("git", "apply", "--verbose", "--reject"),
    ("patch", "--batch", "--fuzz=5", "-p1", "-i"),
)


def _write_exclusive(path: Path, root: Path, content: bytes) -> None:
    resolved_root = root.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    try:
        parent.relative_to(resolved_root)
    except ValueError as error:
        raise EvaluationError("pristine evidence output escaped its root") from error
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


def _read_candidate(path: Path, root: Path) -> bytes:
    resolved_root = root.resolve(strict=True)
    if path.is_symlink():
        raise EvaluationError("candidate patch must not be a symlink")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise EvaluationError("candidate patch escaped its root") from error
    if not resolved.is_file() or resolved.stat().st_size > MAX_PATCH_BYTES:
        raise EvaluationError("candidate patch violates path or size policy")
    value = resolved.read_bytes()
    if b"\x00" in value:
        raise EvaluationError("candidate patch contains a NUL byte")
    return value


def _git(*arguments: str, input_bytes: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-c", "safe.directory=/testbed", "-C", str(WORKSPACE), *arguments],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def _reset(base_commit: str) -> None:
    reset = _git("reset", "--hard", base_commit)
    clean = _git("clean", "-fd")
    head = _git("rev-parse", "HEAD")
    status = _git("status", "--porcelain=v1")
    if (
        reset.returncode != 0
        or clean.returncode != 0
        or head.stdout.strip() != base_commit.encode("ascii")
        or status.stdout.strip()
    ):
        raise EvaluationError("pristine task workspace could not be reset to the frozen base")


def _apply_official_candidate(patch: bytes) -> bool:
    with tempfile.NamedTemporaryFile(mode="wb", suffix=".patch") as handle:
        handle.write(patch)
        handle.flush()
        for command in OFFICIAL_APPLY_COMMANDS:
            if command[0] == "git":
                result = subprocess.run(
                    [*command, handle.name],
                    cwd=WORKSPACE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
            else:
                result = subprocess.run(
                    [*command, handle.name],
                    cwd=WORKSPACE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
            if result.returncode == 0:
                return True
    return False


def _execute_eval_script(script: Path, timeout_seconds: int) -> tuple[int | None, bool, int, bytes]:
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp/repofixlab-home"),
        "CI": "1",
        "NO_PROXY": "*",
        "no_proxy": "*",
    }
    started = time.monotonic_ns()
    process = subprocess.Popen(
        ["/bin/bash", str(script)],
        cwd=WORKSPACE,
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
    if len(output) > MAX_LOG_BYTES:
        raise EvaluationError("pristine task log exceeds its evidence limit")
    return None if timed_out else process.returncode, timed_out, duration_ms, output


def run_probe(
    *,
    probe_kind: str,
    spec: PrivateEvaluationSpec,
    eval_script: Path,
    private_root: Path,
    candidate: Path | None,
    candidate_root: Path,
    evidence_root: Path,
    log_output: Path,
    metadata_output: Path,
    timeout_seconds: int,
) -> dict[str, object]:
    if probe_kind == "base":
        if candidate is not None:
            raise EvaluationError("base probe must not receive a candidate")
        candidate_patch = None
    elif probe_kind == "gold":
        if candidate is not None:
            raise EvaluationError("gold probe must use evaluator-private gold")
        candidate_patch = spec.gold_patch
    else:
        if candidate is None:
            raise EvaluationError("no-op and malformed probes require a candidate")
        candidate_patch = _read_candidate(candidate, candidate_root)
    if probe_kind == "no_op" and candidate_patch != b"":
        raise EvaluationError("no-op candidate is not empty")
    private = private_root.resolve(strict=True)
    script = eval_script.resolve(strict=True)
    try:
        script.relative_to(private)
    except ValueError as error:
        raise EvaluationError("official eval script escaped the evaluator-private root") from error
    if eval_script.is_symlink() or not script.is_file():
        raise EvaluationError("official eval script violates path policy")
    metadata: dict[str, object] = {
        "probe_kind": probe_kind,
        "candidate_patch_sha256": None if candidate_patch is None else sha256_bytes(candidate_patch),
        "candidate_patch_apply_status": "not_applicable" if probe_kind == "base" else "error",
        "test_patch_apply_status": "not_run",
        "test_executed": False,
        "exit_code": None,
        "timed_out": False,
        "duration_ms": 0,
    }
    _reset(spec.base_commit)
    try:
        test_paths = validate_patch(spec.test_patch, WORKSPACE, test_patch=True)
        if candidate_patch:
            if probe_kind != "malformed":
                candidate_paths = validate_patch(candidate_patch, WORKSPACE, test_patch=False)
                reject_path_conflict(candidate_paths, test_paths)
            if not _apply_official_candidate(candidate_patch):
                metadata["candidate_patch_apply_status"] = "error"
                _write_exclusive(metadata_output, evidence_root, canonical_json(metadata))
                return metadata
        if candidate_patch is not None:
            metadata["candidate_patch_apply_status"] = "applied"
        if _git("apply", "--check", "-", input_bytes=spec.test_patch).returncode != 0:
            metadata["test_patch_apply_status"] = "error"
            _write_exclusive(metadata_output, evidence_root, canonical_json(metadata))
            return metadata
        metadata["test_patch_apply_status"] = "applied"
        exit_code, timed_out, duration_ms, log = _execute_eval_script(script, timeout_seconds)
        _write_exclusive(log_output, evidence_root, log)
        metadata.update(
            {
                "test_executed": True,
                "exit_code": exit_code,
                "timed_out": timed_out,
                "duration_ms": duration_ms,
            }
        )
        _write_exclusive(metadata_output, evidence_root, canonical_json(metadata))
        return metadata
    finally:
        _reset(spec.base_commit)


def main() -> int:
    parser = argparse.ArgumentParser(prog="repofixlab-pristine-task-runner")
    parser.add_argument("--probe-kind", choices=("base", "no_op", "malformed", "gold"), required=True)
    parser.add_argument("--private-spec", type=Path, required=True)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--eval-script", type=Path, required=True)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--log-output", type=Path, required=True)
    parser.add_argument("--metadata-output", type=Path, required=True)
    parser.add_argument("--expected-instance-id")
    parser.add_argument("--expected-base-commit")
    parser.add_argument("--timeout-seconds", type=int, choices=range(1, 301), default=300)
    arguments = parser.parse_args()
    try:
        expected_instance_id = arguments.expected_instance_id
        expected_base_commit = arguments.expected_base_commit
        if (expected_instance_id is None) != (expected_base_commit is None):
            raise EvaluationError("task identity options must be supplied together")
        expected_identity = (
            TaskIdentity(expected_instance_id, expected_base_commit)
            if expected_instance_id is not None and expected_base_commit is not None
            else None
        )
        spec = (
            load_private_spec(arguments.private_spec, arguments.private_root)
            if expected_identity is None
            else load_private_spec(arguments.private_spec, arguments.private_root, expected_identity)
        )
        metadata = run_probe(
            probe_kind=arguments.probe_kind,
            spec=spec,
            eval_script=arguments.eval_script,
            private_root=arguments.private_root,
            candidate=arguments.candidate,
            candidate_root=arguments.candidate_root,
            evidence_root=arguments.evidence_root,
            log_output=arguments.log_output,
            metadata_output=arguments.metadata_output,
            timeout_seconds=arguments.timeout_seconds,
        )
        sys.stdout.buffer.write(canonical_json(metadata))
        return 0
    except (EvaluationError, OSError, subprocess.SubprocessError, ValueError):
        sys.stderr.write("repofixlab pristine task runner failed closed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
