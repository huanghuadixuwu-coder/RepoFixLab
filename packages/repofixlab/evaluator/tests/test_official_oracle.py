from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from repofixlab_evaluator.canonical import canonical_json, sha256_bytes
from repofixlab_evaluator.errors import OfficialReportError, OfficialSourceError
from repofixlab_evaluator.official_oracle import (
    OfficialOracleResult,
    load_and_verify_source_lock,
    normalize_pristine_report,
)

from tests.test_runner import RUNTIME_LOCK_SHA, SOURCE_LOCK_SHA, spec

SOURCE_PATHS = (
    "swebench/harness/constants/javascript.py",
    "swebench/harness/grading.py",
    "swebench/harness/log_parsers/__init__.py",
    "swebench/harness/log_parsers/javascript.py",
    "swebench/harness/run_evaluation.py",
    "swebench/harness/test_spec/javascript.py",
)


def source_lock(root: Path) -> tuple[Path, dict[str, object]]:
    files: list[dict[str, str]] = []
    for index, relative in enumerate(SOURCE_PATHS):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        content = f"# pinned fixture {index}\n".encode()
        path.write_bytes(content)
        files.append({"path": relative, "sha256": sha256_bytes(content)})
    unsigned: dict[str, object] = {
        "schema_version": "v1",
        "lock_type": "official_harness_source",
        "lock_id": "official-harness-source-fixture",
        "upstream_version": "v4.1.0",
        "upstream_revision": "726c5461e2ef52d83cf1ea2107870a8bb3328d57",
        "upstream_tree_sha1": "f" * 40,
        "source_scope": "swebench",
        "source_file_count": len(files),
        "source_bytes": sum((root / entry["path"]).stat().st_size for entry in files),
        "source_aggregate_sha256": sha256_bytes(
            canonical_json(
                {
                    "files": [
                        {
                            "path": entry["path"],
                            "bytes": (root / entry["path"]).stat().st_size,
                            "sha256": entry["sha256"],
                        }
                        for entry in files
                    ]
                }
            )
        ),
        "pyproject_sha256": "",
        "files": files,
        "entrypoints": {
            "run_evaluation_module": "swebench.harness.run_evaluation",
            "tap_parser": "swebench.harness.log_parsers.javascript.parse_log_tap",
            "grading_module": "swebench.harness.grading",
        },
        "test_command": ["npx", "mocha", "test/unit/adapters/http.js", "-R", "tap", "-g", "compression"],
        "tap_pattern": r"^(ok|not ok) (\d+) (.+)$",
    }
    pyproject = root / "pyproject.toml"
    pyproject.write_text("[project]\nname='fixture'\n", encoding="utf-8")
    unsigned["pyproject_sha256"] = sha256_bytes(pyproject.read_bytes())
    value = {**unsigned, "lock_sha256": sha256_bytes(canonical_json(unsigned))}
    lock_path = root / "lock.json"
    lock_path.write_bytes(canonical_json(value))
    return lock_path, value


class OfficialSourceTests(unittest.TestCase):
    def test_verifies_every_file_in_the_pinned_official_grading_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock_path, expected = source_lock(root)
            self.assertEqual(load_and_verify_source_lock(lock_path, root), expected)

    def test_fails_closed_when_one_official_source_file_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock_path, _ = source_lock(root)
            (root / "swebench/harness/grading.py").write_text("tampered\n", encoding="utf-8")
            with self.assertRaises(OfficialSourceError):
                load_and_verify_source_lock(lock_path, root)


class PristineNormalizerTests(unittest.TestCase):
    def test_normalizes_direct_official_parser_and_grading_evidence(self) -> None:
        private_spec = spec(
            fail_to_pass=("fixes brotli", "fixes compression"),
            pass_to_pass=("preserves redirects", "preserves timeouts"),
        )
        oracle = OfficialOracleResult(
            found=True,
            status_map={
                "fixes brotli": "passed",
                "fixes compression": "passed",
                "preserves redirects": "passed",
                "preserves timeouts": "passed",
            },
            skipped_tests=frozenset(),
            fail_to_pass={"success": ["fixes brotli", "fixes compression"], "failure": []},
            pass_to_pass={"success": ["preserves redirects", "preserves timeouts"], "failure": []},
            resolved=True,
        )
        official_report = canonical_json(
            {
                private_spec.instance_id: {
                    "patch_is_None": False,
                    "patch_exists": True,
                    "patch_successfully_applied": True,
                    "resolved": True,
                    "tests_status": {
                        "FAIL_TO_PASS": {
                            "success": ["fixes compression", "fixes brotli"],
                            "failure": [],
                        },
                        "PASS_TO_PASS": {
                            "success": ["preserves timeouts", "preserves redirects"],
                            "failure": [],
                        },
                        "FAIL_TO_FAIL": {"success": [], "failure": []},
                        "PASS_TO_FAIL": {"success": [], "failure": []},
                    },
                }
            }
        )
        report = normalize_pristine_report(
            metadata={
                "probe_kind": "gold",
                "candidate_patch_sha256": sha256_bytes(private_spec.gold_patch),
                "candidate_patch_apply_status": "applied",
                "test_patch_apply_status": "applied",
                "test_executed": True,
                "exit_code": 0,
                "timed_out": False,
                "duration_ms": 23,
            },
            oracle=oracle,
            source_lock_sha256=SOURCE_LOCK_SHA,
            pristine_runtime_lock_sha256=RUNTIME_LOCK_SHA,
            test_log=(
                b"ok 1 fixes brotli\n"
                b"ok 2 fixes compression\n"
                b"ok 3 preserves redirects\n"
                b"ok 4 preserves timeouts\n"
            ),
            official_report=official_report,
            spec=private_spec,
        )
        self.assertTrue(report["resolved"])
        self.assertEqual(report["harness_mode"], "pristine")
        self.assertIsNone(report["adapter_sha256"])
        self.assertRegex(str(report["official_report_sha256"]), r"^[a-f0-9]{64}$")

    def test_rejects_test_names_repeated_across_official_partitions(self) -> None:
        private_spec = spec()
        oracle = OfficialOracleResult(
            found=True,
            status_map={"fixes compression": "passed", "preserves redirects": "passed"},
            skipped_tests=frozenset(),
            fail_to_pass={"success": ["fixes compression"], "failure": []},
            pass_to_pass={"success": ["preserves redirects"], "failure": []},
            resolved=True,
        )
        official_report = canonical_json(
            {
                private_spec.instance_id: {
                    "patch_successfully_applied": True,
                    "resolved": True,
                    "tests_status": {
                        "FAIL_TO_PASS": {"success": ["fixes compression"], "failure": []},
                        "PASS_TO_PASS": {"success": ["preserves redirects"], "failure": []},
                        "FAIL_TO_FAIL": {"success": ["fixes compression"], "failure": []},
                        "PASS_TO_FAIL": {"success": [], "failure": []},
                    },
                }
            }
        )
        with self.assertRaises(OfficialReportError):
            normalize_pristine_report(
                metadata={
                    "probe_kind": "gold",
                    "candidate_patch_sha256": sha256_bytes(private_spec.gold_patch),
                    "candidate_patch_apply_status": "applied",
                    "test_patch_apply_status": "applied",
                    "test_executed": True,
                    "exit_code": 0,
                    "timed_out": False,
                    "duration_ms": 23,
                },
                oracle=oracle,
                source_lock_sha256=SOURCE_LOCK_SHA,
                pristine_runtime_lock_sha256=RUNTIME_LOCK_SHA,
                test_log=b"ok 1 fixes compression\nok 2 preserves redirects\n",
                official_report=official_report,
                spec=private_spec,
            )


if __name__ == "__main__":
    unittest.main()
