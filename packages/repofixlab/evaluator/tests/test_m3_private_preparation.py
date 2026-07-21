from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from repofixlab_evaluator.canonical import canonical_json, sha256_bytes
from repofixlab_evaluator.private_spec import TaskIdentity
from repofixlab_evaluator import m3_task_kernel, pristine_runtime


IDENTITY = TaskIdentity(
    "preactjs__preact-4436",
    "0123456789abcdef0123456789abcdef01234567",
)
REPOSITORY = "preactjs/preact"


def private_task() -> dict[str, object]:
    return {
        "schema_version": "v1",
        "record_type": "private_evaluation_spec",
        "dataset_revision": pristine_runtime.DATASET_REVISION,
        "instance_id": IDENTITY.instance_id,
        "gold_patch": "diff --git a/src/a.js b/src/a.js\n",
        "test_patch": "diff --git a/test/a.js b/test/a.js\n",
        "fail_to_pass": ["repairs preact behavior"],
        "pass_to_pass": ["preserves compatible behavior"],
        "harness_parameters": {
            "dataset_name": "SWE-bench/SWE-bench_Multilingual",
            "dataset_revision": pristine_runtime.DATASET_REVISION,
            "repo": REPOSITORY,
            "base_commit": IDENTITY.base_commit,
            "version": "4436",
            "environment_setup_commit": None,
        },
    }


class M3PrivatePreparationTests(unittest.TestCase):
    def test_materializes_a_generic_task_only_when_all_sealed_identities_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset_root = root / "dataset"
            task_path = dataset_root / "tasks" / f"{IDENTITY.instance_id}.json"
            task_path.parent.mkdir(parents=True)
            raw = canonical_json(private_task())
            task_path.write_bytes(raw)
            output = root / "output"
            output.mkdir()
            source_root = root / "source"
            module_path = source_root / "swebench" / "harness" / "test_spec" / "test_spec.py"
            module_path.parent.mkdir(parents=True)
            module_path.write_text("# test fixture\n", encoding="utf-8")
            captured: dict[str, object] = {}

            def make_test_spec(instance: dict[str, object]) -> SimpleNamespace:
                captured.update(instance)
                return SimpleNamespace(eval_script="#!/bin/bash\necho official\n")

            fake_module = SimpleNamespace(__file__=str(module_path), make_test_spec=make_test_spec)
            with (
                patch.object(m3_task_kernel.importlib, "import_module", return_value=fake_module),
            ):
                report = m3_task_kernel.prepare(
                    dataset_task=task_path,
                    dataset_root=dataset_root,
                    output_root=output,
                    expected_task_sha256=sha256_bytes(raw),
                    instance_id=IDENTITY.instance_id,
                    base_commit=IDENTITY.base_commit,
                    repo=REPOSITORY,
                    source_root=source_root,
                )

            self.assertEqual(report["instance_id"], IDENTITY.instance_id)
            self.assertEqual(report["dataset_task_sha256"], sha256_bytes(raw))
            self.assertEqual(captured["repo"], REPOSITORY)
            self.assertEqual(captured["base_commit"], IDENTITY.base_commit)
            self.assertEqual(captured["version"], "4436")
            strict_spec = json.loads((output / "spec.json").read_text(encoding="utf-8"))
            self.assertEqual(strict_spec["instance_id"], IDENTITY.instance_id)
            self.assertEqual(strict_spec["base_commit"], IDENTITY.base_commit)
            self.assertEqual(output.stat().st_mode & 0o777, 0o555)

    def test_rejects_a_private_record_that_does_not_match_its_sealed_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_path = root / "task.json"
            task_path.write_bytes(canonical_json(private_task()))
            output = root / "output"
            output.mkdir()
            with self.assertRaises(m3_task_kernel.M3KernelError):
                m3_task_kernel.prepare(
                    dataset_task=task_path,
                    dataset_root=root,
                    output_root=output,
                    expected_task_sha256="0" * 64,
                    instance_id=IDENTITY.instance_id,
                    base_commit=IDENTITY.base_commit,
                    repo=REPOSITORY,
                    source_root=root,
                )

    def test_uses_the_pinned_official_grader_without_disclosing_test_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_root = root / "private"
            private_root.mkdir()
            strict_spec = {
                "schema_version": "v1",
                "instance_id": IDENTITY.instance_id,
                "base_commit": IDENTITY.base_commit,
                "test_patch": private_task()["test_patch"],
                "gold_patch": private_task()["gold_patch"],
                "fail_to_pass": private_task()["fail_to_pass"],
                "pass_to_pass": private_task()["pass_to_pass"],
            }
            (private_root / "spec.json").write_bytes(canonical_json(strict_spec))
            evidence_root = root / "evidence"
            evidence_root.mkdir()
            log = b">>>>> Start Test Output\ncomplete\n>>>>> End Test Output\n"
            (evidence_root / "official-test.log").write_bytes(log)
            source_root = root / "source"
            module_path = source_root / "swebench" / "harness" / "grading.py"
            module_path.parent.mkdir(parents=True)
            module_path.write_text("# test fixture\n", encoding="utf-8")

            def get_logs_eval(test_spec: SimpleNamespace, log_path: str) -> tuple[dict[str, str], bool]:
                self.assertEqual(test_spec.instance_id, IDENTITY.instance_id)
                self.assertEqual(test_spec.repo, REPOSITORY)
                self.assertEqual(test_spec.version, "4436")
                self.assertEqual(Path(log_path).read_bytes(), log)
                return {
                    "repairs preact behavior": "PASSED",
                    "preserves compatible behavior": "PASSED",
                }, True

            def get_eval_tests_report(
                statuses: dict[str, str],
                expected: dict[str, list[str]],
            ) -> dict[str, dict[str, list[str]]]:
                self.assertEqual(len(statuses), 2)
                return {
                    "FAIL_TO_PASS": {"success": expected["FAIL_TO_PASS"], "failure": []},
                    "PASS_TO_PASS": {"success": expected["PASS_TO_PASS"], "failure": []},
                }

            fake_module = SimpleNamespace(
                __file__=str(module_path),
                get_logs_eval=get_logs_eval,
                get_eval_tests_report=get_eval_tests_report,
                get_resolution_status=lambda partitions: "RESOLVED_FULL",
            )
            with patch.object(m3_task_kernel.importlib, "import_module", return_value=fake_module):
                report = m3_task_kernel.grade(
                    private_root=private_root,
                    evidence_root=evidence_root,
                    instance_id=IDENTITY.instance_id,
                    base_commit=IDENTITY.base_commit,
                    repo=REPOSITORY,
                    source_root=source_root,
                )

            self.assertTrue(report["found"])
            self.assertTrue(report["resolved"])
            self.assertEqual(report["test_log_sha256"], sha256_bytes(log))
            self.assertEqual(report["fail_to_pass"], {"total": 1, "passed": 1, "failed": 0})
            self.assertNotIn("repairs preact behavior", json.dumps(report))



if __name__ == "__main__":
    unittest.main()
