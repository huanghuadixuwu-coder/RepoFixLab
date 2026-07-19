from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from repofixlab_evaluator.errors import TestPatchApplyError
from repofixlab_evaluator.private_spec import BASE_COMMIT, INSTANCE_ID, PrivateEvaluationSpec
from repofixlab_evaluator.runner import EvaluationKernel, ExecutionResult

from tests.test_patches import patch_for

SOURCE_LOCK_SHA = "a" * 64
RUNTIME_LOCK_SHA = "b" * 64


class FakeRepository:
    def __init__(self, *, fail_test_patch: bool = False) -> None:
        self.fail_test_patch = fail_test_patch
        self.reset_count = 0
        self.candidate_apply_count = 0
        self.test_apply_count = 0

    def reset_and_verify_base(self) -> None:
        self.reset_count += 1

    def apply_candidate(self, patch: bytes) -> None:
        self.candidate_apply_count += 1

    def apply_test_patch(self, patch: bytes) -> None:
        self.test_apply_count += 1
        if self.fail_test_patch:
            raise TestPatchApplyError("fixture failure")


class FakeExecutor:
    def __init__(self, result: ExecutionResult) -> None:
        self.result = result
        self.calls = 0

    def execute(self, command: tuple[str, ...], workspace: Path, timeout_seconds: int) -> ExecutionResult:
        self.calls += 1
        return self.result


def spec(
    *,
    fail_to_pass: tuple[str, ...] = ("fixes compression",),
    pass_to_pass: tuple[str, ...] = ("preserves redirects",),
    test_path: str = "test/http.js",
    gold_path: str = "lib/http.js",
) -> PrivateEvaluationSpec:
    return PrivateEvaluationSpec(
        instance_id=INSTANCE_ID,
        base_commit=BASE_COMMIT,
        test_patch=patch_for(test_path),
        gold_patch=patch_for(gold_path),
        fail_to_pass=fail_to_pass,
        pass_to_pass=pass_to_pass,
    )


def result(log: bytes, *, timed_out: bool = False, exit_code: int | None = 0) -> ExecutionResult:
    return ExecutionResult(exit_code=exit_code, timed_out=timed_out, duration_ms=19, log=log)


class EvaluationKernelTests(unittest.TestCase):
    def evaluate(
        self,
        probe_kind: str,
        execution: ExecutionResult,
        *,
        candidate: bytes | None = None,
        private_spec: PrivateEvaluationSpec | None = None,
        repository: FakeRepository | None = None,
    ) -> tuple[dict[str, object], FakeExecutor, FakeRepository]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        candidate_root = root / "input"
        evidence_root = root / "evidence"
        candidate_root.mkdir()
        evidence_root.mkdir()
        candidate_path = None
        if candidate is not None:
            candidate_path = candidate_root / "candidate.patch"
            candidate_path.write_bytes(candidate)
        fake_executor = FakeExecutor(execution)
        fake_repository = repository or FakeRepository()
        kernel = EvaluationKernel(
            root,
            candidate_root=candidate_root,
            evidence_root=evidence_root,
            executor=fake_executor,
            repository=fake_repository,
        )
        report = kernel.evaluate(
            probe_kind=probe_kind,
            spec=private_spec or spec(),
            official_source_lock_sha256=SOURCE_LOCK_SHA,
            pristine_runtime_lock_sha256=RUNTIME_LOCK_SHA,
            candidate_path=candidate_path,
            log_output_path=evidence_root / "test.log",
        )
        return report, fake_executor, fake_repository

    def test_base_and_empty_no_op_are_unresolved(self) -> None:
        log = b"not ok 1 fixes compression\nok 2 preserves redirects\n"
        base, _, _ = self.evaluate("base", result(log))
        no_op, _, _ = self.evaluate("no_op", result(log), candidate=b"")
        self.assertFalse(base["resolved"])
        self.assertFalse(no_op["resolved"])
        self.assertEqual(base["candidate_patch_apply_status"], "not_applicable")
        self.assertEqual(no_op["candidate_patch_apply_status"], "applied")

    def test_malformed_is_patch_apply_error_and_never_runs_tests(self) -> None:
        report, executor, repository = self.evaluate("malformed", result(b""), candidate=b"not a patch")
        self.assertEqual(report["error_class"], "patch_apply_error")
        self.assertEqual(report["candidate_patch_apply_status"], "error")
        self.assertFalse(report["test_executed"])
        self.assertFalse(report["resolved"])
        self.assertEqual(executor.calls, 0)
        self.assertEqual(repository.test_apply_count, 0)

    def test_gold_resolves_only_after_all_f2p_and_p2p_pass(self) -> None:
        log = b"ok 1 fixes compression\nok 2 preserves redirects\n"
        report, executor, repository = self.evaluate("gold", result(log))
        self.assertTrue(report["resolved"])
        self.assertIsNone(report["error_class"])
        self.assertEqual(executor.calls, 1)
        self.assertEqual(repository.candidate_apply_count, 1)
        self.assertEqual(repository.test_apply_count, 1)

    def test_test_patch_failure_is_never_resolved(self) -> None:
        report, executor, _ = self.evaluate(
            "gold",
            result(b"ok 1 fixes compression\nok 2 preserves redirects\n"),
            repository=FakeRepository(fail_test_patch=True),
        )
        self.assertEqual(report["error_class"], "test_patch_apply_error")
        self.assertEqual(report["test_patch_apply_status"], "error")
        self.assertFalse(report["resolved"])
        self.assertEqual(executor.calls, 0)

    def test_missing_target_all_skip_and_timeout_are_never_resolved(self) -> None:
        missing, _, _ = self.evaluate("gold", result(b"ok 1 unrelated\n"))
        self.assertEqual(missing["error_class"], "target_tests_not_collected")
        skipped_name = "fixes compression # SKIP unavailable"
        skipped_spec = spec(fail_to_pass=(skipped_name,), pass_to_pass=())
        skipped, _, _ = self.evaluate(
            "gold",
            result(f"ok 1 {skipped_name}\n".encode()),
            private_spec=skipped_spec,
        )
        self.assertEqual(skipped["error_class"], "all_tests_skipped")
        timed_out, _, _ = self.evaluate(
            "gold",
            result(b"ok 1 fixes compression\nok 2 preserves redirects\n", timed_out=True, exit_code=None),
        )
        self.assertEqual(timed_out["error_class"], "test_timeout")
        self.assertFalse(missing["resolved"])
        self.assertFalse(skipped["resolved"])
        self.assertFalse(timed_out["resolved"])

    def test_candidate_test_conflict_is_rejected_before_execution(self) -> None:
        conflicting = spec(test_path="lib/http.js", gold_path="lib/http.js")
        report, executor, repository = self.evaluate("gold", result(b""), private_spec=conflicting)
        self.assertEqual(report["error_class"], "test_patch_conflict")
        self.assertFalse(report["resolved"])
        self.assertEqual(executor.calls, 0)
        self.assertEqual(repository.candidate_apply_count, 0)

    def test_report_contains_hashes_but_not_private_patch_content(self) -> None:
        private_spec = PrivateEvaluationSpec(
            instance_id=INSTANCE_ID,
            base_commit=BASE_COMMIT,
            test_patch=patch_for("test/private_marker.js"),
            gold_patch=patch_for("lib/gold_secret_marker.js"),
            fail_to_pass=("fixes compression",),
            pass_to_pass=("preserves redirects",),
        )
        report, _, _ = self.evaluate(
            "gold",
            result(b"ok 1 fixes compression\nok 2 preserves redirects\n"),
            private_spec=private_spec,
        )
        serialized = json.dumps(report, sort_keys=True)
        self.assertNotIn("gold_secret_marker", serialized)
        self.assertNotIn("private_marker", serialized)
        self.assertRegex(str(report["candidate_patch_sha256"]), r"^[a-f0-9]{64}$")
        self.assertRegex(str(report["test_patch_sha256"]), r"^[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
