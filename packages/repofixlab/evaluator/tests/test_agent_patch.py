from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch as mock_patch

from repofixlab_evaluator import agent_patch as agent_patch_module
from repofixlab_evaluator.agent_patch import (
    EVALUATION_FILE,
    EVALUATOR_LOG_FILE,
    PATCH_DIAGNOSTICS_FILE,
    evaluate_agent_patch,
    read_agent_candidate,
)
from repofixlab_evaluator.canonical import canonical_json, sha256_bytes
from repofixlab_evaluator.cli import build_parser
from repofixlab_evaluator.errors import PatchApplyError
from repofixlab_evaluator.private_spec import MAX_CANDIDATE_PATCH_BYTES, MAX_PATCH_BYTES
from repofixlab_evaluator.runner import MAX_PERSISTED_EVALUATOR_LOG_BYTES, ExecutionResult

from tests.test_patches import patch_for
from tests.test_private_spec import private_value

FINISHED_AT = "2026-07-19T00:00:00.000Z"
EVALUATION_KEYS = {
    "schema_version",
    "result_type",
    "evaluation_id",
    "job_id",
    "run_id",
    "attempt_id",
    "instance_id",
    "harness_mode",
    "harness_revision",
    "status",
    "resolved",
    "candidate_patch_sha256",
    "candidate_patch_apply_status",
    "test_patch_apply_status",
    "test_executed",
    "test_collected",
    "fail_to_pass",
    "pass_to_pass",
    "exit_code",
    "timed_out",
    "duration_ms",
    "test_log",
    "official_report_sha256",
    "error_class",
    "finished_at",
    "evaluation_sha256",
}


class FakeRepository:
    def __init__(self, *, candidate_conflict: bool = False) -> None:
        self.candidate_conflict = candidate_conflict
        self.reset_count = 0
        self.candidate_apply_count = 0
        self.test_apply_count = 0

    def reset_and_verify_base(self) -> None:
        self.reset_count += 1

    def apply_candidate(self, patch: bytes) -> None:
        self.candidate_apply_count += 1
        if self.candidate_conflict:
            raise PatchApplyError("fixture apply conflict")

    def apply_test_patch(self, patch: bytes) -> None:
        self.test_apply_count += 1


class FakeExecutor:
    def __init__(self, result: ExecutionResult | None = None, *, infrastructure_failure: bool = False) -> None:
        self.result = result
        self.infrastructure_failure = infrastructure_failure
        self.calls = 0

    def execute(
        self,
        command: tuple[str, ...],
        workspace: Path,
        timeout_seconds: int,
    ) -> ExecutionResult:
        self.calls += 1
        if self.infrastructure_failure:
            raise OSError("fixture infrastructure failure")
        if self.result is None:
            raise AssertionError("fixture execution result is absent")
        return self.result


def execution(
    log: bytes,
    *,
    exit_code: int | None = 0,
    timed_out: bool = False,
) -> ExecutionResult:
    return ExecutionResult(
        exit_code=exit_code,
        timed_out=timed_out,
        duration_ms=41,
        log=log,
    )


def candidate_patch_with_size(size: int) -> bytes:
    patch = patch_for("lib/http.js")
    marker = b"+after\n"
    payload_size = size - (len(patch) - len(marker))
    if payload_size < 2:
        raise ValueError("requested candidate patch size is too small")
    candidate = patch.replace(marker, b"+" + b"x" * (payload_size - 2) + b"\n")
    if len(candidate) != size:
        raise AssertionError("candidate patch fixture size drifted")
    return candidate


class AgentPatchEvaluationTests(unittest.TestCase):
    def test_cli_uses_fixed_candidate_and_output_file_protocol(self) -> None:
        arguments = build_parser().parse_args(
            [
                "agent-patch",
                "--private-spec",
                "/run/repofixlab/private/tasks/axios__axios-5892.json",
                "--private-root",
                "/run/repofixlab/private",
                "--workspace",
                "/testbed",
                "--candidate-root",
                "/run/repofixlab/input",
                "--candidate-patch-sha256",
                "a" * 64,
                "--private-spec-sha256",
                "a" * 64,
                "--evidence-root",
                "/run/repofixlab/evidence",
                "--evaluation-id",
                "evaluation-1",
                "--job-id",
                "job-1",
                "--run-id",
                "run-1",
                "--attempt-id",
                "attempt-1",
            ]
        )
        self.assertEqual(arguments.mode, "agent-patch")
        self.assertFalse(hasattr(arguments, "candidate"))
        self.assertFalse(hasattr(arguments, "report_output"))

    def test_python_hash_matches_the_typescript_v1_canonical_fixture(self) -> None:
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "typescript-evaluation-v1.json").read_text(
                encoding="utf-8"
            )
        )
        expected = fixture.pop("evaluation_sha256")
        self.assertEqual(sha256_bytes(canonical_json(fixture)), expected)

    def run_evaluation(
        self,
        patch: bytes,
        *,
        executor: FakeExecutor,
        repository: FakeRepository | None = None,
        expected_sha256: str | None = None,
    ) -> tuple[dict[str, object], dict[str, object], bytes, FakeRepository]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        private_root = root / "private"
        candidate_root = root / "input"
        evidence_root = root / "evidence"
        workspace = root / "testbed"
        for directory in (private_root, candidate_root, evidence_root, workspace):
            directory.mkdir()
        private_spec = private_root / "tasks" / "axios__axios-5892.json"
        private_spec.parent.mkdir()
        strict = private_value()
        private_task = {
            "schema_version": "v1",
            "record_type": "private_evaluation_spec",
            "dataset_revision": agent_patch_module.DATASET_REVISION,
            "instance_id": strict["instance_id"],
            "gold_patch": strict["gold_patch"],
            "test_patch": strict["test_patch"],
            "fail_to_pass": strict["fail_to_pass"],
            "pass_to_pass": strict["pass_to_pass"],
            "harness_parameters": {
                "dataset_name": "SWE-bench/SWE-bench_Multilingual",
                "dataset_revision": agent_patch_module.DATASET_REVISION,
                "repo": "axios/axios",
                "base_commit": strict["base_commit"],
                "version": "5892",
                "environment_setup_commit": "c" * 40,
            },
        }
        private_task_bytes = canonical_json(private_task)
        private_spec.write_bytes(private_task_bytes)
        private_spec_sha256 = sha256_bytes(private_task_bytes)
        (candidate_root / "candidate.patch").write_bytes(patch)
        fake_repository = repository or FakeRepository()
        with mock_patch.object(
            agent_patch_module,
            "PRIVATE_DATASET_TASK_SHA256",
            private_spec_sha256,
        ):
            report = evaluate_agent_patch(
                private_spec_path=private_spec,
                private_root=private_root,
                workspace=workspace,
                candidate_root=candidate_root,
                evidence_root=evidence_root,
                candidate_patch_sha256=expected_sha256 or sha256_bytes(patch),
                private_spec_sha256=private_spec_sha256,
                evaluation_id="evaluation-1",
                job_id="job-1",
                run_id="run-1",
                attempt_id="attempt-1",
                timeout_seconds=30,
                executor=executor,
                repository=fake_repository,
                finished_at=FINISHED_AT,
            )
        disk_report = json.loads((evidence_root / EVALUATION_FILE).read_text(encoding="utf-8"))
        diagnostics = json.loads(
            (evidence_root / PATCH_DIAGNOSTICS_FILE).read_text(encoding="utf-8")
        )
        log = (evidence_root / EVALUATOR_LOG_FILE).read_bytes()
        self.assertEqual(report, disk_report)
        self.assertEqual(set(report), EVALUATION_KEYS)
        self.assertEqual(
            report["evaluation_sha256"],
            sha256_bytes(canonical_json({key: value for key, value in report.items() if key != "evaluation_sha256"})),
        )
        self.assertEqual(
            diagnostics["diagnostics_sha256"],
            sha256_bytes(
                canonical_json(
                    {key: value for key, value in diagnostics.items() if key != "diagnostics_sha256"}
                )
            ),
        )
        return report, diagnostics, log, fake_repository

    def test_success_writes_strict_evaluation_log_and_patch_diagnostics(self) -> None:
        log = b"ok 1 fixes compression\nok 2 preserves redirects\n"
        report, diagnostics, stored_log, repository = self.run_evaluation(
            patch_for("lib/http.js"),
            executor=FakeExecutor(execution(log)),
        )
        self.assertEqual(report["status"], "completed")
        self.assertTrue(report["resolved"])
        self.assertEqual(report["candidate_patch_apply_status"], "applied")
        self.assertEqual(report["test_patch_apply_status"], "applied")
        self.assertEqual(report["finished_at"], FINISHED_AT)
        self.assertEqual(report["test_log"]["path"], EVALUATOR_LOG_FILE)  # type: ignore[index]
        self.assertEqual(stored_log, log)
        self.assertTrue(diagnostics["candidate_hash_verified"])
        self.assertEqual(diagnostics["candidate_paths"], ["lib/http.js"])
        self.assertEqual(diagnostics["stages"]["harness"]["code"], "official_resolved")  # type: ignore[index]
        self.assertEqual(repository.reset_count, 2)

    def test_empty_patch_is_a_valid_noop_that_still_runs_official_tests(self) -> None:
        log = b"not ok 1 fixes compression\nok 2 preserves redirects\n"
        executor = FakeExecutor(execution(log, exit_code=1))
        report, diagnostics, stored_log, repository = self.run_evaluation(b"", executor=executor)
        self.assertEqual(report["status"], "completed")
        self.assertFalse(report["resolved"])
        self.assertEqual(report["candidate_patch_apply_status"], "applied")
        self.assertEqual(report["test_patch_apply_status"], "applied")
        self.assertIsNone(report["error_class"])
        self.assertEqual(
            diagnostics["stages"]["policy"]["code"],  # type: ignore[index]
            "empty_patch_noop",
        )
        self.assertEqual(stored_log, log)
        self.assertEqual(executor.calls, 1)
        self.assertEqual(repository.candidate_apply_count, 0)
        self.assertEqual(repository.test_apply_count, 1)
        self.assertEqual(repository.reset_count, 2)

    def test_malformed_and_path_escape_are_rejected_by_policy(self) -> None:
        for patch in (b"not a patch\n", patch_for("../escape")):
            with self.subTest(patch=patch[:20]):
                executor = FakeExecutor(execution(b""))
                report, diagnostics, _, _ = self.run_evaluation(patch, executor=executor)
                self.assertEqual(report["candidate_patch_apply_status"], "rejected")
                self.assertEqual(report["error_class"], "patch_policy_error")
                self.assertEqual(
                    diagnostics["stages"]["policy"]["code"],  # type: ignore[index]
                    "patch_policy_rejected",
                )
                self.assertEqual(executor.calls, 0)

    def test_apply_conflict_is_structured_and_does_not_run_tests(self) -> None:
        repository = FakeRepository(candidate_conflict=True)
        executor = FakeExecutor(execution(b""))
        report, diagnostics, _, _ = self.run_evaluation(
            patch_for("lib/http.js"),
            executor=executor,
            repository=repository,
        )
        self.assertEqual(report["candidate_patch_apply_status"], "error")
        self.assertEqual(report["error_class"], "patch_apply_error")
        self.assertEqual(diagnostics["stages"]["candidate_apply"]["status"], "error")  # type: ignore[index]
        self.assertEqual(
            diagnostics["stages"]["candidate_apply"]["code"],  # type: ignore[index]
            "patch_apply_error",
        )
        self.assertEqual(executor.calls, 0)
        self.assertEqual(repository.test_apply_count, 0)

    def test_official_test_failure_is_completed_but_unresolved(self) -> None:
        log = b"not ok 1 fixes compression\nok 2 preserves redirects\n"
        report, diagnostics, _, _ = self.run_evaluation(
            patch_for("lib/http.js"),
            executor=FakeExecutor(execution(log, exit_code=1)),
        )
        self.assertEqual(report["status"], "completed")
        self.assertFalse(report["resolved"])
        self.assertIsNone(report["error_class"])
        self.assertEqual(report["fail_to_pass"]["failure"], ["fixes compression"])  # type: ignore[index]
        self.assertEqual(diagnostics["stages"]["harness"]["code"], "official_unresolved")  # type: ignore[index]

    def test_timeout_and_infrastructure_failure_are_distinct_terminal_results(self) -> None:
        timeout_report, _, _, _ = self.run_evaluation(
            patch_for("lib/http.js"),
            executor=FakeExecutor(execution(b"ok 1 fixes compression\n", exit_code=None, timed_out=True)),
        )
        self.assertEqual(timeout_report["status"], "failed")
        self.assertEqual(timeout_report["error_class"], "test_timeout")
        self.assertTrue(timeout_report["timed_out"])

        infrastructure_report, diagnostics, log, _ = self.run_evaluation(
            patch_for("lib/http.js"),
            executor=FakeExecutor(infrastructure_failure=True),
        )
        self.assertEqual(infrastructure_report["status"], "failed")
        self.assertEqual(infrastructure_report["error_class"], "internal_error")
        self.assertFalse(infrastructure_report["test_executed"])
        self.assertFalse(infrastructure_report["timed_out"])
        self.assertEqual(diagnostics["stages"]["harness"]["status"], "not_run")  # type: ignore[index]
        self.assertIn(b'"error_class":"internal_error"', log)

    def test_large_harness_log_is_parsed_in_full_but_persisted_with_a_delivery_marker(self) -> None:
        test_results = b"\nok 1 fixes compression\nok 2 preserves redirects\n"
        original_log = b"h" * 600_000 + test_results + b"t" * 600_000
        report, _, persisted_log, _ = self.run_evaluation(
            patch_for("lib/http.js"),
            executor=FakeExecutor(execution(original_log)),
        )

        self.assertTrue(report["resolved"])
        self.assertEqual(len(persisted_log), MAX_PERSISTED_EVALUATOR_LOG_BYTES)
        self.assertIn(
            f"original_bytes={len(original_log)} retained=head+tail".encode("ascii"),
            persisted_log,
        )
        self.assertNotIn(test_results.strip(), persisted_log)
        self.assertEqual(report["test_log"]["bytes"], len(persisted_log))  # type: ignore[index]
        self.assertEqual(report["test_log"]["sha256"], sha256_bytes(persisted_log))  # type: ignore[index]

    def test_size_encoding_and_controller_hash_are_checked_before_policy(self) -> None:
        accepted_large_patch = candidate_patch_with_size(MAX_PATCH_BYTES + 1)
        accepted_report, accepted_diagnostics, _, _ = self.run_evaluation(
            accepted_large_patch,
            executor=FakeExecutor(
                execution(b"ok 1 fixes compression\nok 2 preserves redirects\n")
            ),
        )
        self.assertEqual(accepted_report["candidate_patch_apply_status"], "applied")
        self.assertTrue(accepted_report["resolved"])
        self.assertTrue(accepted_diagnostics["candidate_hash_verified"])

        oversized_patch = candidate_patch_with_size(MAX_CANDIDATE_PATCH_BYTES + 1)
        report, diagnostics, _, _ = self.run_evaluation(
            oversized_patch,
            executor=FakeExecutor(execution(b"")),
        )
        self.assertEqual(report["candidate_patch_apply_status"], "rejected")
        self.assertEqual(report["error_class"], "patch_policy_error")
        self.assertFalse(diagnostics["candidate_hash_verified"])
        self.assertEqual(diagnostics["stages"]["input"]["code"], "candidate_too_large")  # type: ignore[index]

        invalid_utf8 = b"\xff\xfe"
        invalid_report, invalid_diagnostics, _, _ = self.run_evaluation(
            invalid_utf8,
            executor=FakeExecutor(execution(b"")),
        )
        self.assertEqual(invalid_report["candidate_patch_apply_status"], "rejected")
        self.assertEqual(invalid_report["error_class"], "patch_policy_error")
        self.assertEqual(
            invalid_diagnostics["stages"]["input"]["code"],  # type: ignore[index]
            "candidate_invalid_utf8",
        )

        valid_patch = patch_for("lib/http.js")
        mismatch_report, mismatch_diagnostics, _, _ = self.run_evaluation(
            valid_patch,
            executor=FakeExecutor(execution(b"")),
            expected_sha256="b" * 64,
        )
        self.assertEqual(mismatch_report["candidate_patch_sha256"], "b" * 64)
        self.assertEqual(mismatch_report["error_class"], "candidate_patch_integrity_error")
        self.assertFalse(mismatch_diagnostics["candidate_hash_verified"])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate.patch"
            candidate.write_bytes(oversized_patch)
            oversized = read_agent_candidate(root, "a" * 64)
            self.assertEqual(oversized.code, "candidate_too_large")
            self.assertFalse(oversized.hash_verified)

            candidate.write_bytes(invalid_utf8)
            invalid = read_agent_candidate(root, sha256_bytes(invalid_utf8))
            self.assertEqual(invalid.code, "candidate_invalid_utf8")
            self.assertFalse(invalid.hash_verified)

            valid = patch_for("lib/http.js")
            candidate.write_bytes(valid)
            mismatch = read_agent_candidate(root, "b" * 64)
            self.assertEqual(mismatch.code, "candidate_hash_mismatch")
            self.assertEqual(mismatch.error_class, "candidate_patch_integrity_error")

    def test_patch_bytes_worker_state_and_credentials_never_enter_structured_outputs(self) -> None:
        secret = b"WORKER_API_KEY=worker-secret-marker"
        candidate = patch_for("lib/http.js").replace(b"+after", b"+" + secret)
        report, diagnostics, log, _ = self.run_evaluation(
            candidate,
            executor=FakeExecutor(execution(b"")),
            repository=FakeRepository(candidate_conflict=True),
        )
        evidence = canonical_json(report) + canonical_json(diagnostics) + log
        self.assertNotIn(secret, evidence)
        self.assertNotIn(b"worker_status", evidence)


if __name__ == "__main__":
    unittest.main()
