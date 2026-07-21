from __future__ import annotations

import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from repofixlab_evaluator.m6_candidate_patch import (
    CANDIDATE_RUN_FILE,
    EVALUATION_FILE,
    execute_candidate,
    finalize_official_evaluation,
    repository_for_instance,
)


INSTANCE_ID = "axios__axios-4731"
BASE_COMMIT = "a" * 40


def _canonical(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


class M6CandidatePatchTests(unittest.TestCase):
    def test_rejected_candidate_is_finalized_without_hidden_test_names(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            private_root = root / "private"
            candidate_root = root / "candidate"
            evidence_root = root / "evidence"
            workspace = root / "workspace"
            for directory in (private_root, candidate_root, evidence_root, workspace):
                directory.mkdir()
            spec = {
                "schema_version": "v1",
                "instance_id": INSTANCE_ID,
                "base_commit": BASE_COMMIT,
                "test_patch": "diff --git a/private-test b/private-test\n",
                "gold_patch": "diff --git a/implementation b/implementation\n",
                "fail_to_pass": ["hidden::must-not-leak"],
                "pass_to_pass": ["hidden::regression"],
            }
            raw_spec = _canonical(spec)
            spec_path = private_root / "spec.json"
            spec_path.write_bytes(raw_spec)
            result = execute_candidate(
                private_spec_path=spec_path,
                private_root=private_root,
                workspace=workspace,
                candidate_root=candidate_root,
                evidence_root=evidence_root,
                private_spec_sha256=hashlib.sha256(raw_spec).hexdigest(),
                candidate_patch_sha256="b" * 64,
                instance_id=INSTANCE_ID,
                base_commit=BASE_COMMIT,
                evaluation_id="evaluation-m6-test",
                job_id="job-m6-test",
                run_id="run-m6-test",
                attempt_id="attempt-m6-test",
                timeout_seconds=30,
            )
            self.assertEqual(result["candidate_patch_apply_status"], "rejected")
            self.assertFalse(result["test_executed"])
            candidate_run = (evidence_root / CANDIDATE_RUN_FILE).read_text(encoding="utf-8")
            self.assertNotIn("hidden::", candidate_run)
            final = finalize_official_evaluation(
                private_root=private_root,
                evidence_root=evidence_root,
                instance_id=INSTANCE_ID,
                base_commit=BASE_COMMIT,
                repo="axios/axios",
                source_root=root,
            )
            self.assertFalse(final["resolved"])
            self.assertIsNone(final["official_grading"])
            self.assertTrue((evidence_root / EVALUATION_FILE).is_file())

    def test_repository_mapping_only_accepts_the_frozen_m6_population(self) -> None:
        self.assertEqual(repository_for_instance(INSTANCE_ID), "axios/axios")
        with self.assertRaisesRegex(RuntimeError, "frozen M6 repository population"):
            repository_for_instance("unknown__repository-1")


if __name__ == "__main__":
    unittest.main()
