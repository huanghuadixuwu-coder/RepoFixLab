from __future__ import annotations

import importlib
import json
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from .canonical import canonical_json, sha256_bytes, sha256_file
from .errors import OfficialReportError, OfficialSourceError
from .private_spec import PrivateEvaluationSpec

HARNESS_REVISION = "726c5461e2ef52d83cf1ea2107870a8bb3328d57"
_SKIP_DIRECTIVE = re.compile(r"(?:^|\s)#\s*SKIP(?:\s|$)", re.IGNORECASE)
_REQUIRED_SOURCE_PATHS = (
    "swebench/harness/constants/javascript.py",
    "swebench/harness/grading.py",
    "swebench/harness/log_parsers/__init__.py",
    "swebench/harness/log_parsers/javascript.py",
    "swebench/harness/run_evaluation.py",
    "swebench/harness/test_spec/javascript.py",
)
_TEST_COMMAND = (
    "npx",
    "mocha",
    "test/unit/adapters/http.js",
    "-R",
    "tap",
    "-g",
    "compression",
)


@dataclass(frozen=True)
class OfficialOracleResult:
    found: bool
    status_map: dict[str, str]
    skipped_tests: frozenset[str]
    fail_to_pass: dict[str, list[str]]
    pass_to_pass: dict[str, list[str]]
    resolved: bool


def _strict_json(path: Path, maximum_bytes: int) -> object:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum_bytes:
        raise OfficialSourceError("official evidence file violates path or size policy")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OfficialSourceError("official evidence is not strict UTF-8 JSON") from error


def load_and_verify_source_lock(lock_path: Path, source_root: Path) -> dict[str, object]:
    value = _strict_json(lock_path, 256 * 1024)
    required = {
        "schema_version",
        "lock_type",
        "lock_id",
        "upstream_version",
        "upstream_revision",
        "upstream_tree_sha1",
        "source_scope",
        "source_file_count",
        "source_bytes",
        "source_aggregate_sha256",
        "pyproject_sha256",
        "files",
        "entrypoints",
        "test_command",
        "tap_pattern",
        "lock_sha256",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise OfficialSourceError("official source lock fields do not match v1")
    if (
        value["schema_version"] != "v1"
        or value["lock_type"] != "official_harness_source"
        or value["upstream_version"] != "v4.1.0"
        or value["upstream_revision"] != HARNESS_REVISION
        or value["source_scope"] != "swebench"
        or tuple(value["test_command"]) != _TEST_COMMAND
        or value["tap_pattern"] != r"^(ok|not ok) (\d+) (.+)$"
    ):
        raise OfficialSourceError("official source lock constants drifted")
    actual_hash = value["lock_sha256"]
    if not isinstance(actual_hash, str):
        raise OfficialSourceError("official source lock hash is invalid")
    unsigned = dict(value)
    del unsigned["lock_sha256"]
    if sha256_bytes(canonical_json(unsigned)) != actual_hash:
        raise OfficialSourceError("official source lock canonical hash mismatches")
    files = value["files"]
    if not isinstance(files, list):
        raise OfficialSourceError("official source file lock is invalid")
    paths: list[str] = []
    root = source_root.resolve(strict=True)
    pyproject_path = root / "pyproject.toml"
    if pyproject_path.is_symlink() or not pyproject_path.is_file() or sha256_file(str(pyproject_path)) != value["pyproject_sha256"]:
        raise OfficialSourceError("official dependency declaration hash mismatches")
    source_entries: list[dict[str, object]] = []
    source_directory = root / "swebench"
    for path in sorted(source_directory.rglob("*")):
        if path.is_symlink():
            raise OfficialSourceError("official source tree contains a symlink")
        if not path.is_file():
            continue
        source_entries.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(str(path)),
            }
        )
    source_bytes = sum(int(entry["bytes"]) for entry in source_entries)
    source_aggregate = sha256_bytes(canonical_json({"files": source_entries}))
    if (
        value["source_file_count"] != len(source_entries)
        or value["source_bytes"] != source_bytes
        or value["source_aggregate_sha256"] != source_aggregate
    ):
        raise OfficialSourceError("official full package source aggregate mismatches")
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise OfficialSourceError("official source file entry is invalid")
        relative = entry["path"]
        expected_hash = entry["sha256"]
        if not isinstance(relative, str) or not isinstance(expected_hash, str):
            raise OfficialSourceError("official source file entry types are invalid")
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise OfficialSourceError("official source file is absent or a symlink")
        try:
            path.resolve(strict=True).relative_to(root)
        except ValueError as error:
            raise OfficialSourceError("official source file escapes the source root") from error
        if sha256_file(str(path)) != expected_hash:
            raise OfficialSourceError("official source file hash mismatches")
        paths.append(relative)
    if tuple(paths) != _REQUIRED_SOURCE_PATHS:
        raise OfficialSourceError("official source lock does not cover the complete Axios grading path")
    entrypoints = value["entrypoints"]
    if entrypoints != {
        "run_evaluation_module": "swebench.harness.run_evaluation",
        "tap_parser": "swebench.harness.log_parsers.javascript.parse_log_tap",
        "grading_module": "swebench.harness.grading",
    }:
        raise OfficialSourceError("official source entrypoints drifted")
    return value


def _import_official_modules(source_root: Path) -> tuple[ModuleType, ModuleType]:
    root_text = str(source_root.resolve(strict=True))
    for name in tuple(sys.modules):
        if name == "swebench" or name.startswith("swebench."):
            del sys.modules[name]
    sys.path.insert(0, root_text)
    try:
        parser_module = importlib.import_module("swebench.harness.log_parsers.javascript")
        grading_module = importlib.import_module("swebench.harness.grading")
    except Exception as error:
        raise OfficialSourceError("pinned official harness modules could not be imported") from error
    finally:
        if sys.path[0] == root_text:
            del sys.path[0]
    for module in (parser_module, grading_module):
        module_path = Path(str(module.__file__)).resolve(strict=True)
        try:
            module_path.relative_to(source_root.resolve(strict=True))
        except ValueError as error:
            raise OfficialSourceError("official callable resolved outside the pinned source root") from error
    return parser_module, grading_module


def run_official_oracle(
    *,
    source_root: Path,
    source_lock_path: Path,
    test_log: bytes,
    spec: PrivateEvaluationSpec,
) -> tuple[OfficialOracleResult, str]:
    source_lock = load_and_verify_source_lock(source_lock_path, source_root)
    _parser_module, grading_module = _import_official_modules(source_root)
    try:
        class OfficialTestSpecShim:
            repo = "axios/axios"
            version = "5892"

        with tempfile.NamedTemporaryFile(mode="wb") as handle:
            handle.write(test_log)
            handle.flush()
            official_statuses, found = grading_module.get_logs_eval(OfficialTestSpecShim(), handle.name)
        official_report = grading_module.get_eval_tests_report(
            official_statuses,
            {
                "FAIL_TO_PASS": list(spec.fail_to_pass),
                "PASS_TO_PASS": list(spec.pass_to_pass),
            },
        )
        resolution = grading_module.get_resolution_status(official_report)
    except Exception as error:
        raise OfficialReportError("official parser or grading callable failed") from error
    status_mapping = {
        "PASSED": "passed",
        "FAILED": "failed",
        "ERROR": "error",
        "SKIPPED": "skipped",
        "XFAIL": "xfailed",
    }
    if not isinstance(official_statuses, dict) or any(
        not isinstance(name, str) or status not in status_mapping
        for name, status in official_statuses.items()
    ):
        raise OfficialReportError("official parser returned an invalid status map")
    statuses = {name: status_mapping[status] for name, status in official_statuses.items()}
    fail_to_pass = official_report.get("FAIL_TO_PASS")
    pass_to_pass = official_report.get("PASS_TO_PASS")
    if not isinstance(fail_to_pass, dict) or not isinstance(pass_to_pass, dict):
        raise OfficialReportError("official grading report is missing F2P or P2P")
    normalized_f2p = {
        "success": sorted(fail_to_pass.get("success", [])),
        "failure": sorted(fail_to_pass.get("failure", [])),
    }
    normalized_p2p = {
        "success": sorted(pass_to_pass.get("success", [])),
        "failure": sorted(pass_to_pass.get("failure", [])),
    }
    if any(not isinstance(item, str) for values in (*normalized_f2p.values(), *normalized_p2p.values()) for item in values):
        raise OfficialReportError("official grading report contains invalid test names")
    return (
        OfficialOracleResult(
            found=bool(found),
            status_map=statuses,
            skipped_tests=frozenset(name for name in statuses if _SKIP_DIRECTIVE.search(name) is not None),
            fail_to_pass=normalized_f2p,
            pass_to_pass=normalized_p2p,
            resolved=resolution == "RESOLVED_FULL",
        ),
        str(source_lock["lock_sha256"]),
    )


def create_official_report(
    *,
    source_root: Path,
    source_lock_path: Path,
    test_log: bytes,
    spec: PrivateEvaluationSpec,
) -> bytes:
    load_and_verify_source_lock(source_lock_path, source_root)
    _parser_module, grading_module = _import_official_modules(source_root)
    try:
        class OfficialTestSpecShim:
            instance_id = spec.instance_id
            repo = "axios/axios"
            version = "5892"
            FAIL_TO_PASS = list(spec.fail_to_pass)
            PASS_TO_PASS = list(spec.pass_to_pass)

        prediction = {
            "instance_id": spec.instance_id,
            "model_name_or_path": "repofixlab-pristine-probe",
            "model_patch": "",
        }
        with tempfile.NamedTemporaryFile(mode="wb") as handle:
            handle.write(test_log)
            handle.flush()
            report = grading_module.get_eval_report(
                test_spec=OfficialTestSpecShim(),
                prediction=prediction,
                test_log_path=handle.name,
                include_tests_status=True,
            )
    except Exception as error:
        raise OfficialReportError("official get_eval_report callable failed") from error
    if not isinstance(report, dict) or set(report) != {spec.instance_id}:
        raise OfficialReportError("official get_eval_report returned an invalid report")
    return canonical_json(report)


def _normalized_official_test_partitions(value: object) -> dict[str, dict[str, list[str]]]:
    partition_names = ("FAIL_TO_PASS", "PASS_TO_PASS", "FAIL_TO_FAIL", "PASS_TO_FAIL")
    if not isinstance(value, dict) or set(value) != set(partition_names):
        raise OfficialReportError("official report test partitions are incomplete")
    normalized: dict[str, dict[str, list[str]]] = {}
    all_names: set[str] = set()
    for partition_name in partition_names:
        partition = value[partition_name]
        if not isinstance(partition, dict) or set(partition) != {"success", "failure"}:
            raise OfficialReportError("official report test partition fields are invalid")
        success = partition["success"]
        failure = partition["failure"]
        if (
            not isinstance(success, list)
            or not isinstance(failure, list)
            or any(not isinstance(name, str) or not name for name in (*success, *failure))
        ):
            raise OfficialReportError("official report test partition contains invalid test names")
        partition_names_seen = [*success, *failure]
        if len(set(partition_names_seen)) != len(partition_names_seen):
            raise OfficialReportError("official report test partition contains duplicate test names")
        if all_names.intersection(partition_names_seen):
            raise OfficialReportError("official report test name appears across partitions")
        all_names.update(partition_names_seen)
        normalized[partition_name] = {
            "success": sorted(success),
            "failure": sorted(failure),
        }
    return normalized


def normalize_pristine_report(
    *,
    metadata: dict[str, object],
    oracle: OfficialOracleResult,
    source_lock_sha256: str,
    pristine_runtime_lock_sha256: str,
    test_log: bytes | None,
    official_report: bytes,
    spec: PrivateEvaluationSpec,
) -> dict[str, object]:
    if re.fullmatch(r"[a-f0-9]{64}", pristine_runtime_lock_sha256) is None:
        raise OfficialReportError("pristine runtime lock SHA-256 is invalid")
    required = {
        "probe_kind",
        "candidate_patch_sha256",
        "candidate_patch_apply_status",
        "test_patch_apply_status",
        "test_executed",
        "exit_code",
        "timed_out",
        "duration_ms",
    }
    if set(metadata) != required:
        raise OfficialReportError("pristine metadata fields do not match the v1 protocol")
    probe_kind = metadata["probe_kind"]
    if probe_kind not in {"base", "no_op", "malformed", "gold"}:
        raise OfficialReportError("pristine probe kind is invalid")
    candidate_hash = metadata["candidate_patch_sha256"]
    if candidate_hash is not None and (
        not isinstance(candidate_hash, str)
        or re.fullmatch(r"[a-f0-9]{64}", candidate_hash) is None
    ):
        raise OfficialReportError("pristine candidate patch hash is invalid")
    if (probe_kind == "base") != (candidate_hash is None):
        raise OfficialReportError("pristine candidate patch hash does not match the probe kind")
    if probe_kind == "no_op" and candidate_hash != sha256_bytes(b""):
        raise OfficialReportError("pristine no-op probe does not bind the empty patch")
    if probe_kind == "gold" and candidate_hash != sha256_bytes(spec.gold_patch):
        raise OfficialReportError("pristine gold probe does not bind evaluator-private gold")
    candidate_status = metadata["candidate_patch_apply_status"]
    test_patch_status = metadata["test_patch_apply_status"]
    if candidate_status not in {"not_applicable", "applied", "error", "rejected"}:
        raise OfficialReportError("pristine candidate patch status is invalid")
    if test_patch_status not in {"not_run", "applied", "error", "rejected"}:
        raise OfficialReportError("pristine test patch status is invalid")
    if probe_kind == "base" and candidate_status != "not_applicable":
        raise OfficialReportError("pristine base probe candidate status is invalid")
    test_executed_value = metadata["test_executed"]
    timed_out_value = metadata["timed_out"]
    exit_code_value = metadata["exit_code"]
    duration_value = metadata["duration_ms"]
    if not isinstance(test_executed_value, bool) or not isinstance(timed_out_value, bool):
        raise OfficialReportError("pristine execution flags are invalid")
    if (
        (exit_code_value is not None and (not isinstance(exit_code_value, int) or isinstance(exit_code_value, bool)))
        or not isinstance(duration_value, int)
        or isinstance(duration_value, bool)
        or duration_value < 0
        or duration_value > 300_000
    ):
        raise OfficialReportError("pristine execution result is invalid")
    if test_executed_value != (exit_code_value is not None or timed_out_value):
        raise OfficialReportError("pristine execution metadata is inconsistent")
    if timed_out_value and exit_code_value is not None:
        raise OfficialReportError("pristine timeout must not claim an exit code")
    try:
        official_value = json.loads(official_report.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OfficialReportError("official report is not strict UTF-8 JSON") from error
    if not isinstance(official_value, dict) or set(official_value) != {spec.instance_id}:
        raise OfficialReportError("official report does not contain exactly the frozen instance")
    instance_report = official_value[spec.instance_id]
    if not isinstance(instance_report, dict):
        raise OfficialReportError("official instance report is invalid")
    if bool(instance_report.get("resolved")) != oracle.resolved:
        raise OfficialReportError("official report and direct official grading disagree")
    expected_patch_applied = (
        candidate_status in {"not_applicable", "applied"}
        and test_patch_status == "applied"
    )
    if bool(instance_report.get("patch_successfully_applied")) != expected_patch_applied:
        raise OfficialReportError("official patch status and pristine metadata disagree")
    official_tests = instance_report.get("tests_status")
    expected_tests = {
        "FAIL_TO_PASS": oracle.fail_to_pass,
        "PASS_TO_PASS": oracle.pass_to_pass,
    }
    test_executed = test_executed_value
    if not test_executed and oracle.found:
        raise OfficialReportError("official get_logs_eval found tests although pristine execution did not run")
    if test_executed:
        normalized_official_tests = _normalized_official_test_partitions(official_tests)
        if (
            normalized_official_tests["FAIL_TO_PASS"] != expected_tests["FAIL_TO_PASS"]
            or normalized_official_tests["PASS_TO_PASS"] != expected_tests["PASS_TO_PASS"]
            or normalized_official_tests["FAIL_TO_FAIL"] != {"success": [], "failure": []}
            or normalized_official_tests["PASS_TO_FAIL"] != {"success": [], "failure": []}
        ):
            raise OfficialReportError("official report test partitions disagree with direct official grading")
    elif official_tests is not None:
        raise OfficialReportError("official report contains test partitions although tests did not run")
    log_sha = sha256_bytes(test_log) if test_executed and test_log is not None else None
    if test_executed != (test_log is not None):
        raise OfficialReportError("pristine test log presence disagrees with execution metadata")
    collected = sorted(oracle.status_map) if test_executed else []
    skipped = sorted(oracle.skipped_tests) if test_executed else []
    error_class: str | None = None
    targets = set(spec.fail_to_pass) | set(spec.pass_to_pass)
    if candidate_status in {"error", "rejected"}:
        error_class = "patch_apply_error" if candidate_status == "error" else "patch_policy_error"
    elif test_patch_status in {"error", "rejected"}:
        error_class = "test_patch_apply_error" if test_patch_status == "error" else "test_patch_policy_error"
    elif timed_out_value:
        error_class = "test_timeout"
    elif test_executed and not targets.issubset(oracle.status_map):
        error_class = "target_tests_not_collected"
    elif test_executed and collected and set(collected) == set(skipped):
        error_class = "all_tests_skipped"
    elif test_executed and not collected:
        error_class = "test_execution_error"
    resolved = oracle.resolved and error_class is None
    report: dict[str, object] = {
        "schema_version": "v1",
        "report_type": "harness_probe",
        "harness_mode": "pristine",
        "probe_kind": probe_kind,
        "instance_id": spec.instance_id,
        "base_commit": spec.base_commit,
        "harness_revision": HARNESS_REVISION,
        "official_source_lock_sha256": source_lock_sha256,
        "pristine_runtime_lock_sha256": pristine_runtime_lock_sha256,
        "adapter_sha256": None,
        "candidate_patch_sha256": metadata["candidate_patch_sha256"],
        "test_patch_sha256": sha256_bytes(spec.test_patch),
        "candidate_patch_apply_status": metadata["candidate_patch_apply_status"],
        "test_patch_apply_status": metadata["test_patch_apply_status"],
        "test_executed": test_executed,
        "test_collected": bool(collected),
        "test_status_map": [{"name": name, "status": oracle.status_map[name]} for name in collected],
        "collected_tests": collected,
        "skipped_tests": skipped,
        "fail_to_pass": oracle.fail_to_pass,
        "pass_to_pass": oracle.pass_to_pass,
        "resolved": resolved,
        "exit_code": metadata["exit_code"],
        "timed_out": metadata["timed_out"],
        "duration_ms": metadata["duration_ms"],
        "test_log_sha256": log_sha,
        "official_report_sha256": sha256_bytes(official_report),
        "error_class": error_class,
    }
    report["report_sha256"] = sha256_bytes(canonical_json(report))
    return report
