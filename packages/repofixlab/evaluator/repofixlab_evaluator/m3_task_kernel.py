"""M3 generic private-task preparation and official-image preflight kernel.

This module is copied by the Trusted Controller into short-lived containers. It
is intentionally stdlib-only so the official SWE-bench task image can execute
the preflight runner without inheriting a host Python environment. It never
writes a hidden patch, test name, issue text, or evaluator script to stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace


MAX_PRIVATE_TASK_BYTES = 512 * 1024
MAX_PATCH_BYTES = 2 * 1024 * 1024
MAX_LOG_BYTES = 32 * 1024 * 1024
WORKSPACE = Path("/testbed")
_INSTANCE_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,199}__[a-z0-9][a-z0-9_.-]{0,199}$")
_GIT_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_DENIED_PATH_PARTS = {".git", ".gitmodules", ".repofixlab", "node_modules"}
_DIFF_PATH = re.compile(r"^diff --git a/([^\s]+) b/([^\s]+)$")


class M3KernelError(RuntimeError):
    """Fail-closed error whose details must not leave the evaluator boundary."""


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        + "\n"
    ).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _require_identity(instance_id: str, base_commit: str) -> None:
    if _INSTANCE_ID.fullmatch(instance_id) is None or _GIT_COMMIT.fullmatch(base_commit) is None:
        raise M3KernelError("task identity violates the M3 policy")


def _task_version(instance_id: str) -> str:
    suffix = instance_id.rsplit("__", maxsplit=1)[1]
    _repository, separator, version = suffix.rpartition("-")
    if not separator or not version.isdecimal():
        raise M3KernelError("task identity does not encode a SWE-bench version")
    return version


def _read_confined(path: Path, root: Path, maximum_bytes: int) -> bytes:
    resolved_root = root.resolve(strict=True)
    if not resolved_root.is_dir() or path.is_symlink():
        raise M3KernelError("input root or path violates confinement policy")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise M3KernelError("input path escapes its allowed root") from error
    descriptor = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        value = os.read(descriptor, maximum_bytes + 1)
    finally:
        os.close(descriptor)
    if len(value) > maximum_bytes:
        raise M3KernelError("input exceeds the M3 size limit")
    return value


def _write_exclusive(path: Path, root: Path, value: bytes, mode: int) -> None:
    resolved_root = root.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    try:
        parent.relative_to(resolved_root)
    except ValueError as error:
        raise M3KernelError("output path escapes its allowed root") from error
    descriptor = os.open(
        parent / path.name,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        mode,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _parse_private_task(raw: bytes, instance_id: str, base_commit: str, repo: str) -> dict[str, object]:
    _require_identity(instance_id, base_commit)
    if not repo or repo.strip() != repo or any(character.isspace() for character in repo):
        raise M3KernelError("public repository identity is invalid")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise M3KernelError("private task is not strict UTF-8 JSON") from error
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
        raise M3KernelError("private task fields violate the M3 contract")
    harness = value["harness_parameters"]
    if (
        value["schema_version"] != "v1"
        or value["record_type"] != "private_evaluation_spec"
        or value["instance_id"] != instance_id
        or not isinstance(value["dataset_revision"], str)
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
        or harness["dataset_revision"] != value["dataset_revision"]
        or harness["repo"] != repo
        or harness["base_commit"] != base_commit
        or harness["version"] != _task_version(instance_id)
        or not isinstance(harness["dataset_name"], str)
        or not isinstance(harness["repo"], str)
        or not isinstance(harness["version"], str)
        or (
            harness["environment_setup_commit"] is not None
            and (
                not isinstance(harness["environment_setup_commit"], str)
                or _GIT_COMMIT.fullmatch(harness["environment_setup_commit"]) is None
            )
        )
    ):
        raise M3KernelError("private task identity or harness parameters drifted")
    for patch_name in ("test_patch", "gold_patch"):
        patch = value[patch_name]
        if not isinstance(patch, str) or not patch or len(patch.encode("utf-8")) > MAX_PATCH_BYTES or "\x00" in patch:
            raise M3KernelError("private task patch violates the M3 policy")
    for test_set in ("fail_to_pass", "pass_to_pass"):
        tests = value[test_set]
        if (
            not isinstance(tests, list)
            or any(not isinstance(test, str) or not test or len(test) > 2000 for test in tests)
            or len(set(tests)) != len(tests)
        ):
            raise M3KernelError("private task test partition violates the M3 policy")
    if not value["fail_to_pass"] or set(value["fail_to_pass"]) & set(value["pass_to_pass"]):
        raise M3KernelError("private task test partitions are unusable")
    return value


def prepare(
    *,
    dataset_task: Path,
    dataset_root: Path,
    output_root: Path,
    expected_task_sha256: str,
    instance_id: str,
    base_commit: str,
    repo: str,
    source_root: Path,
) -> dict[str, object]:
    if _SHA256.fullmatch(expected_task_sha256) is None:
        raise M3KernelError("sealed private task SHA-256 is invalid")
    raw = _read_confined(dataset_task, dataset_root, MAX_PRIVATE_TASK_BYTES)
    if _sha256(raw) != expected_task_sha256:
        raise M3KernelError("private task SHA-256 mismatches the sealed DatasetLock")
    task = _parse_private_task(raw, instance_id, base_commit, repo)
    output = output_root.resolve(strict=True)
    if not output.is_dir() or any(output.iterdir()):
        raise M3KernelError("private preparation output must be an empty directory")
    module = importlib.import_module("swebench.harness.test_spec.test_spec")
    module_path = Path(str(module.__file__)).resolve(strict=True)
    try:
        module_path.relative_to(source_root.resolve(strict=True))
    except ValueError as error:
        raise M3KernelError("official TestSpec factory escaped the pinned harness source") from error
    make_test_spec = getattr(module, "make_test_spec", None)
    if not callable(make_test_spec):
        raise M3KernelError("official TestSpec factory is unavailable")
    official_instance = {
        "instance_id": instance_id,
        "repo": repo,
        "version": _task_version(instance_id),
        "base_commit": base_commit,
        "test_patch": task["test_patch"],
        "FAIL_TO_PASS": task["fail_to_pass"],
        "PASS_TO_PASS": task["pass_to_pass"],
        "environment_setup_commit": task["harness_parameters"]["environment_setup_commit"],
    }
    test_spec = make_test_spec(official_instance)
    eval_script = getattr(test_spec, "eval_script", None)
    if not isinstance(eval_script, str) or not eval_script:
        raise M3KernelError("official TestSpec did not produce an evaluator script")
    strict_spec = {
        "schema_version": "v1",
        "instance_id": instance_id,
        "base_commit": base_commit,
        "test_patch": task["test_patch"],
        "gold_patch": task["gold_patch"],
        "fail_to_pass": task["fail_to_pass"],
        "pass_to_pass": task["pass_to_pass"],
    }
    spec_bytes = _canonical_json(strict_spec)
    script_bytes = eval_script.encode("utf-8")
    _write_exclusive(output / "spec.json", output, spec_bytes, 0o444)
    _write_exclusive(output / "eval.sh", output, script_bytes, 0o444)
    # The official task image runs as root with every Linux capability dropped.
    # It therefore cannot bypass a preparer-owned 0700 directory. Seal this
    # task-specific derivative read-only only after both files are fsynced;
    # the original DatasetLock private volume remains 0600 and is never mounted
    # into the task image or Agent container.
    os.chmod(output, 0o555)
    directory_descriptor = os.open(output, os.O_RDONLY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
    return {
        "schema_version": "v1",
        "record_type": "m3_private_task_preparation",
        "instance_id": instance_id,
        "dataset_task_sha256": expected_task_sha256,
        "strict_spec_sha256": _sha256(spec_bytes),
        "official_eval_script_sha256": _sha256(script_bytes),
    }


def _load_strict_spec(path: Path, root: Path, instance_id: str, base_commit: str) -> dict[str, object]:
    raw = _read_confined(path, root, MAX_PATCH_BYTES * 2 + 256 * 1024)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise M3KernelError("prepared private spec is not strict UTF-8 JSON") from error
    required = {"schema_version", "instance_id", "base_commit", "test_patch", "gold_patch", "fail_to_pass", "pass_to_pass"}
    if not isinstance(value, dict) or set(value) != required:
        raise M3KernelError("prepared private spec fields violate the M3 contract")
    if value["schema_version"] != "v1" or value["instance_id"] != instance_id or value["base_commit"] != base_commit:
        raise M3KernelError("prepared private spec identity mismatches the sealed task")
    for patch_name in ("test_patch", "gold_patch"):
        patch = value[patch_name]
        if not isinstance(patch, str) or not patch or len(patch.encode("utf-8")) > MAX_PATCH_BYTES or "\x00" in patch:
            raise M3KernelError("prepared private spec patch violates the M3 policy")
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
        raise M3KernelError("official task workspace could not be reset to the sealed base")


def _validate_adapted_patch(patch: bytes) -> None:
    try:
        text = patch.decode("utf-8")
    except UnicodeDecodeError as error:
        raise M3KernelError("adapted patch is not UTF-8") from error
    paths: set[str] = set()
    for line in text.splitlines():
        match = _DIFF_PATH.match(line)
        if match is not None:
            paths.update(match.groups())
    if not paths:
        raise M3KernelError("adapted patch has no strict Git diff header")
    for value in paths:
        path = PurePosixPath(value)
        if value != path.as_posix() or path.is_absolute() or any(part in {"", ".", ".."} | _DENIED_PATH_PARTS for part in path.parts):
            raise M3KernelError("adapted patch path violates the M3 policy")


def _apply_pristine(patch: bytes) -> bool:
    with tempfile.NamedTemporaryFile(mode="wb", suffix=".patch") as handle:
        handle.write(patch)
        handle.flush()
        for command in (
            ("git", "apply", "--verbose", handle.name),
            ("git", "apply", "--verbose", "--reject", handle.name),
            ("patch", "--batch", "--fuzz=5", "-p1", "-i", handle.name),
        ):
            result = subprocess.run(
                command,
                cwd=WORKSPACE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            if result.returncode == 0:
                return True
    return False


def _apply_adapted(patch: bytes) -> bool:
    _validate_adapted_patch(patch)
    for arguments in (
        ("apply", "--check", "--whitespace=nowarn", "--recount", "-"),
        ("apply", "--whitespace=nowarn", "--recount", "-"),
    ):
        result = _git(*arguments, input_bytes=patch)
        if result.returncode != 0:
            return False
    return True


def _execute_eval_script(script: Path, timeout_seconds: int) -> tuple[int | None, bool, int, bytes]:
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": "/tmp/repofixlab-home",
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
        raise M3KernelError("official task log exceeds the M3 evidence limit")
    return None if timed_out else process.returncode, timed_out, duration_ms, output


def grade(
    *,
    private_root: Path,
    evidence_root: Path,
    instance_id: str,
    base_commit: str,
    repo: str,
    source_root: Path,
) -> dict[str, object]:
    """Grade one official task log using only the pinned SWE-bench harness."""
    _require_identity(instance_id, base_commit)
    if not repo or repo.strip() != repo or any(character.isspace() for character in repo):
        raise M3KernelError("public repository identity is invalid")
    spec = _load_strict_spec(private_root / "spec.json", private_root, instance_id, base_commit)
    log = _read_confined(evidence_root / "official-test.log", evidence_root, MAX_LOG_BYTES)
    grading = importlib.import_module("swebench.harness.grading")
    module_path = Path(str(grading.__file__)).resolve(strict=True)
    try:
        module_path.relative_to(source_root.resolve(strict=True))
    except ValueError as error:
        raise M3KernelError("official grader escaped the pinned harness source") from error
    get_logs_eval = getattr(grading, "get_logs_eval", None)
    get_eval_tests_report = getattr(grading, "get_eval_tests_report", None)
    get_resolution_status = getattr(grading, "get_resolution_status", None)
    if not all(callable(value) for value in (get_logs_eval, get_eval_tests_report, get_resolution_status)):
        raise M3KernelError("official grader is incomplete")
    test_spec = SimpleNamespace(
        instance_id=instance_id,
        repo=repo,
        version=_task_version(instance_id),
    )
    try:
        statuses, found = get_logs_eval(test_spec, str((evidence_root / "official-test.log").resolve(strict=True)))
        partitions = get_eval_tests_report(
            statuses,
            {
                "FAIL_TO_PASS": list(spec["fail_to_pass"]),
                "PASS_TO_PASS": list(spec["pass_to_pass"]),
            },
        )
        resolution = get_resolution_status(partitions)
    except Exception as error:
        raise M3KernelError("official grader rejected the task log") from error
    if not isinstance(found, bool) or not isinstance(statuses, dict) or any(
        not isinstance(name, str) or not isinstance(status, str) for name, status in statuses.items()
    ):
        raise M3KernelError("official grader returned an invalid status map")
    counts: dict[str, dict[str, int]] = {}
    for external, internal in (("fail_to_pass", "FAIL_TO_PASS"), ("pass_to_pass", "PASS_TO_PASS")):
        partition = partitions.get(internal) if isinstance(partitions, dict) else None
        if not isinstance(partition, dict):
            raise M3KernelError("official grader returned an invalid test partition")
        successful = partition.get("success")
        failed = partition.get("failure")
        expected = spec[external]
        if (
            not isinstance(successful, list)
            or not isinstance(failed, list)
            or any(not isinstance(item, str) for item in [*successful, *failed])
            or set(successful) | set(failed) != set(expected)
            or set(successful) & set(failed)
        ):
            raise M3KernelError("official grader test partition drifted")
        counts[external] = {"total": len(expected), "passed": len(successful), "failed": len(failed)}
    if not isinstance(resolution, str):
        raise M3KernelError("official grader resolution is invalid")
    return {
        "schema_version": "v1",
        "record_type": "m3_official_log_grade",
        "instance_id": instance_id,
        "test_log_sha256": _sha256(log),
        "found": found,
        "resolved": found and resolution == "RESOLVED_FULL",
        "status_map_sha256": _sha256(_canonical_json(statuses)),
        "fail_to_pass": counts["fail_to_pass"],
        "pass_to_pass": counts["pass_to_pass"],
    }


def run(
    *,
    mode: str,
    probe_kind: str,
    private_root: Path,
    evidence_root: Path,
    instance_id: str,
    base_commit: str,
    timeout_seconds: int,
) -> dict[str, object]:
    if mode not in {"pristine", "adapted"} or probe_kind not in {"base", "gold"}:
        raise M3KernelError("M3 preflight mode or probe kind is invalid")
    _require_identity(instance_id, base_commit)
    spec = _load_strict_spec(private_root / "spec.json", private_root, instance_id, base_commit)
    script = private_root / "eval.sh"
    if script.is_symlink() or not script.is_file():
        raise M3KernelError("official evaluator script violates the M3 policy")
    evidence = evidence_root.resolve(strict=True)
    if not evidence.is_dir() or any(evidence.iterdir()):
        raise M3KernelError("M3 evidence output must be an empty directory")
    candidate = None if probe_kind == "base" else spec["gold_patch"].encode("utf-8")
    test_patch = spec["test_patch"].encode("utf-8")
    report: dict[str, object] = {
        "schema_version": "v1",
        "record_type": "m3_official_image_preflight",
        "harness_mode": mode,
        "probe_kind": probe_kind,
        "instance_id": instance_id,
        "base_commit": base_commit,
        "candidate_patch_sha256": None if candidate is None else _sha256(candidate),
        "test_patch_sha256": _sha256(test_patch),
        "candidate_patch_apply_status": "not_applicable" if candidate is None else "error",
        "test_patch_apply_status": "not_run",
        "test_executed": False,
        "exit_code": None,
        "timed_out": False,
        "duration_ms": 0,
        "test_log_sha256": None,
        "resolved": False,
    }
    _reset(base_commit)
    try:
        if candidate is not None:
            candidate_applied = _apply_pristine(candidate) if mode == "pristine" else _apply_adapted(candidate)
            if not candidate_applied:
                _write_exclusive(evidence / "report.json", evidence, _canonical_json(report), 0o600)
                return report
            report["candidate_patch_apply_status"] = "applied"
        if _git("apply", "--check", "-", input_bytes=test_patch).returncode != 0:
            report["test_patch_apply_status"] = "error"
            _write_exclusive(evidence / "report.json", evidence, _canonical_json(report), 0o600)
            return report
        report["test_patch_apply_status"] = "applied"
        exit_code, timed_out, duration_ms, log = _execute_eval_script(script, timeout_seconds)
        _write_exclusive(evidence / "official-test.log", evidence, log, 0o444)
        report.update(
            {
                "test_executed": True,
                "exit_code": exit_code,
                "timed_out": timed_out,
                "duration_ms": duration_ms,
                "test_log_sha256": _sha256(log),
                "resolved": False,
            }
        )
        _write_exclusive(evidence / "report.json", evidence, _canonical_json(report), 0o600)
        return report
    finally:
        _reset(base_commit)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="repofixlab-m3-task-kernel")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--dataset-task", type=Path, required=True)
    prepare_parser.add_argument("--dataset-root", type=Path, required=True)
    prepare_parser.add_argument("--output-root", type=Path, required=True)
    prepare_parser.add_argument("--expected-task-sha256", required=True)
    prepare_parser.add_argument("--instance-id", required=True)
    prepare_parser.add_argument("--base-commit", required=True)
    prepare_parser.add_argument("--repo", required=True)
    prepare_parser.add_argument("--source-root", type=Path, default=Path("/opt/upstream"))
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--mode", choices=("pristine", "adapted"), required=True)
    run_parser.add_argument("--probe-kind", choices=("base", "gold"), required=True)
    run_parser.add_argument("--private-root", type=Path, required=True)
    run_parser.add_argument("--evidence-root", type=Path, required=True)
    run_parser.add_argument("--instance-id", required=True)
    run_parser.add_argument("--base-commit", required=True)
    run_parser.add_argument("--timeout-seconds", type=int, choices=range(1, 301), default=300)
    grade_parser = commands.add_parser("grade")
    grade_parser.add_argument("--private-root", type=Path, required=True)
    grade_parser.add_argument("--evidence-root", type=Path, required=True)
    grade_parser.add_argument("--instance-id", required=True)
    grade_parser.add_argument("--base-commit", required=True)
    grade_parser.add_argument("--repo", required=True)
    grade_parser.add_argument("--source-root", type=Path, default=Path("/opt/upstream"))
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "prepare":
            report = prepare(
                dataset_task=arguments.dataset_task,
                dataset_root=arguments.dataset_root,
                output_root=arguments.output_root,
                expected_task_sha256=arguments.expected_task_sha256,
                instance_id=arguments.instance_id,
                base_commit=arguments.base_commit,
                repo=arguments.repo,
                source_root=arguments.source_root,
            )
        elif arguments.command == "run":
            report = run(
                mode=arguments.mode,
                probe_kind=arguments.probe_kind,
                private_root=arguments.private_root,
                evidence_root=arguments.evidence_root,
                instance_id=arguments.instance_id,
                base_commit=arguments.base_commit,
                timeout_seconds=arguments.timeout_seconds,
            )
        else:
            report = grade(
                private_root=arguments.private_root,
                evidence_root=arguments.evidence_root,
                instance_id=arguments.instance_id,
                base_commit=arguments.base_commit,
                repo=arguments.repo,
                source_root=arguments.source_root,
            )
        sys.stdout.buffer.write(_canonical_json(report))
        return 0
    except (M3KernelError, OSError, subprocess.SubprocessError, ValueError):
        sys.stderr.write("repofixlab M3 task kernel failed closed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
