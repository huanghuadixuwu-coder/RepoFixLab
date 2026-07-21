from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from pathlib import Path

from .canonical import canonical_json, sha256_bytes, sha256_file
from .errors import EvaluationError, OfficialSourceError
from .integrity import directory_aggregate
from .official_oracle import (
    HARNESS_REVISION,
    create_official_report,
    load_and_verify_source_lock,
    normalize_pristine_report,
    run_official_oracle,
)
from .private_spec import (
    BASE_COMMIT,
    INSTANCE_ID,
    PrivateEvaluationSpec,
    TaskIdentity,
    load_private_spec,
)

SOURCE_ROOT = Path("/opt/upstream")
SOURCE_LOCK_PATH = Path("/opt/locks/official-source-lock.json")
DEPENDENCY_LOCK_PATH = Path("/opt/locks/requirements.lock")
KERNEL_ROOT = Path("/opt/repofixlab/repofixlab_evaluator")
PROVENANCE_PATH = Path("/opt/provenance/build-provenance.json")
MAX_PROVENANCE_BYTES = 64 * 1024
PRIVATE_DATASET_TASK_SHA256 = "a592340952c75bf326d9ca45bdef7a2e635dcb5648c674e6a9fae25bae165f50"
DATASET_REVISION = "2b7aced941b4873e9cad3e76abbae93f481d1beb"
_PROVENANCE_FIELDS = {
    "schema_version",
    "artifact_type",
    "platform",
    "base_image",
    "upstream_revision",
    "upstream_tree_sha1",
    "source_archive_sha256",
    "source_lock_sha256",
    "source_aggregate_sha256",
    "dependency_lock_sha256",
    "evaluator_kernel_aggregate_sha256",
    "evaluator_kernel_file_count",
    "evaluator_kernel_bytes",
    "dockerfile_sha256",
    "provenance_sha256",
}


def _load_provenance() -> dict[str, object]:
    if (
        PROVENANCE_PATH.is_symlink()
        or not PROVENANCE_PATH.is_file()
        or PROVENANCE_PATH.stat().st_size > MAX_PROVENANCE_BYTES
    ):
        raise OfficialSourceError("pristine build provenance violates path or size policy")
    try:
        value = json.loads(PROVENANCE_PATH.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OfficialSourceError("pristine build provenance is not strict UTF-8 JSON") from error
    if not isinstance(value, dict) or set(value) != _PROVENANCE_FIELDS:
        raise OfficialSourceError("pristine build provenance fields do not match v1")
    claimed_hash = value["provenance_sha256"]
    unsigned = dict(value)
    del unsigned["provenance_sha256"]
    if not isinstance(claimed_hash, str) or sha256_bytes(canonical_json(unsigned)) != claimed_hash:
        raise OfficialSourceError("pristine build provenance canonical hash mismatches")
    expected_hash = os.environ.get("REPOFIXLAB_PROVENANCE_SHA256")
    if expected_hash != claimed_hash:
        raise OfficialSourceError("pristine build provenance is not bound to the image")
    return value


def _assert_official_import(source_root: Path) -> str:
    module = importlib.import_module("swebench.harness.run_evaluation")
    module_path = Path(str(module.__file__)).resolve(strict=True)
    try:
        relative = module_path.relative_to(source_root.resolve(strict=True))
    except ValueError as error:
        raise OfficialSourceError("official run_evaluation import escaped the pinned source") from error
    return relative.as_posix()


def _run_golden_oracle() -> dict[str, object]:
    fail_to_pass = "restores compression"
    pass_to_pass = "preserves redirects"
    test_log = (
        ">>>>> Start Test Output\n"
        "TAP version 13\n"
        f"ok 1 {fail_to_pass}\n"
        f"ok 2 {pass_to_pass}\n"
        "1..2\n"
        ">>>>> End Test Output\n"
    ).encode("utf-8")
    spec = PrivateEvaluationSpec(
        instance_id=INSTANCE_ID,
        base_commit=BASE_COMMIT,
        test_patch=b"golden self-check test patch\n",
        gold_patch=b"golden self-check candidate patch\n",
        fail_to_pass=(fail_to_pass,),
        pass_to_pass=(pass_to_pass,),
    )
    oracle, source_lock_hash = run_official_oracle(
        source_root=SOURCE_ROOT,
        source_lock_path=SOURCE_LOCK_PATH,
        test_log=test_log,
        spec=spec,
    )
    if (
        not oracle.found
        or not oracle.resolved
        or oracle.status_map != {fail_to_pass: "passed", pass_to_pass: "passed"}
        or oracle.fail_to_pass != {"success": [fail_to_pass], "failure": []}
        or oracle.pass_to_pass != {"success": [pass_to_pass], "failure": []}
    ):
        raise OfficialSourceError("official golden oracle self-check did not resolve")
    return {
        "source_lock_sha256": source_lock_hash,
        "test_log_sha256": sha256_bytes(test_log),
        "status_map_sha256": sha256_bytes(canonical_json(oracle.status_map)),
        "resolved": oracle.resolved,
    }


def self_check() -> dict[str, object]:
    provenance = _load_provenance()
    if (
        provenance["schema_version"] != "v1"
        or provenance["artifact_type"] != "repofixlab_pristine_harness"
        or provenance["platform"] != "linux/amd64"
        or provenance["upstream_revision"] != HARNESS_REVISION
    ):
        raise OfficialSourceError("pristine build provenance identity drifted")
    if sha256_file(str(DEPENDENCY_LOCK_PATH)) != provenance["dependency_lock_sha256"]:
        raise OfficialSourceError("pristine dependency lock hash mismatches")
    kernel_hash, kernel_files, kernel_bytes = directory_aggregate(KERNEL_ROOT)
    if (
        kernel_hash != provenance["evaluator_kernel_aggregate_sha256"]
        or kernel_files != provenance["evaluator_kernel_file_count"]
        or kernel_bytes != provenance["evaluator_kernel_bytes"]
    ):
        raise OfficialSourceError("pristine evaluator kernel aggregate mismatches")
    source_lock = load_and_verify_source_lock(SOURCE_LOCK_PATH, SOURCE_ROOT)
    if (
        source_lock["lock_sha256"] != provenance["source_lock_sha256"]
        or source_lock["source_aggregate_sha256"] != provenance["source_aggregate_sha256"]
        or source_lock["upstream_tree_sha1"] != provenance["upstream_tree_sha1"]
    ):
        raise OfficialSourceError("pristine source provenance mismatches verified source")
    import_path = _assert_official_import(SOURCE_ROOT)
    golden = _run_golden_oracle()
    return {
        "schema_version": "v1",
        "check_type": "pristine_harness_self_check",
        "status": "pass",
        "platform": provenance["platform"],
        "upstream_revision": provenance["upstream_revision"],
        "source_lock_sha256": provenance["source_lock_sha256"],
        "dependency_lock_sha256": provenance["dependency_lock_sha256"],
        "evaluator_kernel_aggregate_sha256": kernel_hash,
        "provenance_sha256": provenance["provenance_sha256"],
        "run_evaluation_import": import_path,
        "golden_oracle": golden,
    }


def _write_exclusive(path: Path, root: Path, content: bytes, mode: int = 0o600) -> None:
    resolved_root = root.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    try:
        parent.relative_to(resolved_root)
    except ValueError as error:
        raise EvaluationError("pristine output escaped its root") from error
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


def _read_confined(path: Path, root: Path, maximum_bytes: int) -> bytes:
    resolved_root = root.resolve(strict=True)
    if path.is_symlink():
        raise EvaluationError("pristine input must not be a symlink")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise EvaluationError("pristine input escaped its root") from error
    if not resolved.is_file() or resolved.stat().st_size > maximum_bytes:
        raise EvaluationError("pristine input violates path or size policy")
    return resolved.read_bytes()


def _task_version_from_instance_id(instance_id: str) -> str:
    suffix = instance_id.rsplit("__", maxsplit=1)[1]
    _repository, separator, version = suffix.rpartition("-")
    if not separator or not version.isdecimal():
        raise EvaluationError("task instance ID does not contain a decimal SWE-bench version")
    return version


def prepare_private_task(
    *,
    dataset_task: Path,
    dataset_root: Path,
    output_root: Path,
    expected_task_sha256: str,
    expected_identity: TaskIdentity,
    expected_repo: str,
) -> dict[str, object]:
    if len(expected_task_sha256) != 64 or any(character not in "0123456789abcdef" for character in expected_task_sha256):
        raise EvaluationError("sealed private task SHA-256 is invalid")
    if not expected_repo or expected_repo.strip() != expected_repo or any(character.isspace() for character in expected_repo):
        raise EvaluationError("sealed public repository identity is invalid")
    raw = _read_confined(dataset_task, dataset_root, 64 * 1024)
    if sha256_bytes(raw) != expected_task_sha256:
        raise EvaluationError("private task does not match the sealed dataset record")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvaluationError("private task is not strict UTF-8 JSON") from error
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
        raise EvaluationError("private task fields do not match the sealed contract")
    harness = value["harness_parameters"]
    expected_version = _task_version_from_instance_id(expected_identity.instance_id)
    if (
        value["schema_version"] != "v1"
        or value["record_type"] != "private_evaluation_spec"
        or value["dataset_revision"] != DATASET_REVISION
        or value["instance_id"] != expected_identity.instance_id
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
        or harness["dataset_revision"] != DATASET_REVISION
        or harness["repo"] != expected_repo
        or harness["base_commit"] != expected_identity.base_commit
        or harness["version"] != expected_version
        or not isinstance(harness["dataset_name"], str)
        or not isinstance(harness["repo"], str)
        or not isinstance(harness["version"], str)
        or harness["environment_setup_commit"] is not None
        and (
            not isinstance(harness["environment_setup_commit"], str)
            or len(harness["environment_setup_commit"]) != 40
        )
    ):
        raise EvaluationError("private task identity or harness parameters drifted")
    strict_spec = {
        "schema_version": "v1",
        "instance_id": expected_identity.instance_id,
        "base_commit": expected_identity.base_commit,
        "test_patch": value["test_patch"],
        "gold_patch": value["gold_patch"],
        "fail_to_pass": value["fail_to_pass"],
        "pass_to_pass": value["pass_to_pass"],
    }
    output = output_root.resolve(strict=True)
    if not output.is_dir() or any(output.iterdir()):
        raise EvaluationError("evaluator-private probe root is not an empty directory")
    spec_path = output / "spec.json"
    _write_exclusive(spec_path, output, canonical_json(strict_spec), 0o444)
    load_private_spec(spec_path, output, expected_identity)
    module = importlib.import_module("swebench.harness.test_spec.test_spec")
    module_path = Path(str(module.__file__)).resolve(strict=True)
    try:
        module_path.relative_to(SOURCE_ROOT.resolve(strict=True))
    except ValueError as error:
        raise OfficialSourceError("official TestSpec factory escaped the pinned source") from error
    official_instance = {
        "instance_id": expected_identity.instance_id,
        "repo": expected_repo,
        "version": expected_version,
        "base_commit": expected_identity.base_commit,
        "test_patch": value["test_patch"],
        "FAIL_TO_PASS": value["fail_to_pass"],
        "PASS_TO_PASS": value["pass_to_pass"],
        "environment_setup_commit": harness["environment_setup_commit"],
    }
    test_spec = module.make_test_spec(official_instance)
    eval_script = test_spec.eval_script.encode("utf-8")
    eval_path = output / "eval.sh"
    _write_exclusive(eval_path, output, eval_script, 0o444)
    return {
        "schema_version": "v1",
        "operation": "prepare_pristine_private_task",
        "instance_id": expected_identity.instance_id,
        "dataset_task_sha256": expected_task_sha256,
        "strict_spec_sha256": sha256_file(str(spec_path)),
        "official_eval_script_sha256": sha256_bytes(eval_script),
    }


def normalize_probe(
    *,
    private_spec: Path,
    private_root: Path,
    metadata_path: Path,
    test_log_path: Path | None,
    pristine_runtime_lock_sha256: str,
    evidence_root: Path,
    official_report_output: Path,
    report_output: Path,
) -> dict[str, object]:
    spec = load_private_spec(private_spec, private_root)
    metadata_raw = _read_confined(metadata_path, evidence_root, 64 * 1024)
    try:
        metadata = json.loads(metadata_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvaluationError("pristine metadata is not strict UTF-8 JSON") from error
    if not isinstance(metadata, dict):
        raise EvaluationError("pristine metadata is not an object")
    if test_log_path is None:
        test_log = None
    else:
        test_log = _read_confined(test_log_path, evidence_root, 32 * 1024 * 1024)
    official_report = create_official_report(
        source_root=SOURCE_ROOT,
        source_lock_path=SOURCE_LOCK_PATH,
        test_log=test_log or b"",
        spec=spec,
    )
    oracle, source_lock_sha256 = run_official_oracle(
        source_root=SOURCE_ROOT,
        source_lock_path=SOURCE_LOCK_PATH,
        test_log=test_log or b"",
        spec=spec,
    )
    report = normalize_pristine_report(
        metadata=metadata,
        oracle=oracle,
        source_lock_sha256=source_lock_sha256,
        pristine_runtime_lock_sha256=pristine_runtime_lock_sha256,
        test_log=test_log,
        official_report=official_report,
        spec=spec,
    )
    _write_exclusive(official_report_output, evidence_root, official_report)
    _write_exclusive(report_output, evidence_root, canonical_json(report))
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="repofixlab-pristine-runtime")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("self-check")
    prepare = subparsers.add_parser("prepare-private")
    prepare.add_argument("--dataset-task", type=Path, required=True)
    prepare.add_argument("--dataset-root", type=Path, required=True)
    prepare.add_argument("--output-root", type=Path, required=True)
    prepare.add_argument("--expected-task-sha256", required=True)
    prepare.add_argument("--expected-instance-id", required=True)
    prepare.add_argument("--expected-base-commit", required=True)
    prepare.add_argument("--expected-repo", required=True)
    normalize = subparsers.add_parser("normalize-probe")
    normalize.add_argument("--private-spec", type=Path, required=True)
    normalize.add_argument("--private-root", type=Path, required=True)
    normalize.add_argument("--metadata", type=Path, required=True)
    normalize.add_argument("--test-log", type=Path)
    normalize.add_argument("--pristine-runtime-lock-sha256", required=True)
    normalize.add_argument("--evidence-root", type=Path, required=True)
    normalize.add_argument("--official-report-output", type=Path, required=True)
    normalize.add_argument("--report-output", type=Path, required=True)
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        check = self_check()
        if arguments.command == "self-check":
            output = check
        elif arguments.command == "prepare-private":
            output = prepare_private_task(
                dataset_task=arguments.dataset_task,
                dataset_root=arguments.dataset_root,
                output_root=arguments.output_root,
                expected_task_sha256=arguments.expected_task_sha256,
                expected_identity=TaskIdentity(
                    arguments.expected_instance_id,
                    arguments.expected_base_commit,
                ),
                expected_repo=arguments.expected_repo,
            )
        else:
            output = normalize_probe(
                private_spec=arguments.private_spec,
                private_root=arguments.private_root,
                metadata_path=arguments.metadata,
                test_log_path=arguments.test_log,
                pristine_runtime_lock_sha256=arguments.pristine_runtime_lock_sha256,
                evidence_root=arguments.evidence_root,
                official_report_output=arguments.official_report_output,
                report_output=arguments.report_output,
            )
        sys.stdout.buffer.write(canonical_json(output))
        return 0
    except (EvaluationError, OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        sys.stderr.write("repofixlab pristine runtime failed closed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
