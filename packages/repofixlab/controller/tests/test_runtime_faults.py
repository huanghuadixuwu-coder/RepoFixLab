"""Exercise interrupted writes, repeated recovery and scoped cancellation."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
import unittest
from unittest.mock import patch

from repofixlab_controller.runtime_docker import DockerRuntimeBackend, RuntimeDockerError
from repofixlab_controller.runtime_journal import RuntimeJournalError, RuntimeOperationJournal
from repofixlab_controller.runtime_service import (
    RuntimeCleanupResult, RuntimeInvalidState, RuntimeOperationConflict,
    RuntimeOperationService, RuntimeServiceUnavailable,
)
from repofixlab_controller.runtime_worker_pool import WorkerPool
import test_runtime_docker as docker_fixture
import test_runtime_service as service_fixture


class InterruptedJournalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.request = service_fixture._write_request("runtime_preflight", "attempt", "operation", note="中文")
        canonical = dict(self.request)
        canonical.pop("request_sha256")
        journal = RuntimeOperationJournal(self.root / "source")
        journal.begin(canonical, self.request["request_sha256"])
        self.accepted = (journal.root / "journal.jsonl").read_bytes()
        journal.finish(canonical, self.request["request_sha256"], {
            "schema_version": "v1", "response_type": "runtime_preflight", "status": "ready",
            "attempt_id": "attempt", "operation_id": "operation",
            "request_sha256": self.request["request_sha256"],
        })
        self.complete = (journal.root / "journal.jsonl").read_bytes()
        journal.close()

    def tearDown(self):
        self.temporary.cleanup()

    def test_terminal_write_cuts_keep_valid_prefix_and_forensic_tail(self):
        terminal = self.complete[len(self.accepted):]
        chinese = terminal.index("中文".encode("utf-8"))
        for index, cut in enumerate((1, 2, 100, chinese + 1, chinese + 2, len(terminal) - 1)):
            with self.subTest(cut=cut):
                journal = RuntimeOperationJournal(self.root / str(index))
                try:
                    tail = terminal[:cut]
                    (journal.root / "journal.jsonl").write_bytes(self.accepted + tail)
                    operations = journal.load()
                    self.assertEqual(len(operations), 1)
                    self.assertIsNone(operations[0].response)
                    self.assertEqual((journal.root / "journal.jsonl").read_bytes(), self.accepted)
                    copies = list(journal.root.glob("interrupted-tail-*.bin"))
                    self.assertEqual(len(copies), 1)
                    self.assertEqual(copies[0].read_bytes(), tail)
                    self.assertIn(hashlib.sha256(tail).hexdigest(), copies[0].name)
                    self.assertEqual(journal.load(), operations)
                finally:
                    journal.close()

    def test_empty_crash_file_accepts_a_new_durable_operation(self):
        journal = RuntimeOperationJournal(self.root / "empty")
        try:
            (journal.root / "journal.jsonl").touch()
            self.assertEqual(journal.load(), ())
            canonical = dict(self.request)
            canonical.pop("request_sha256")
            journal.begin(canonical, self.request["request_sha256"])
            self.assertEqual(len(journal.load()), 1)
        finally:
            journal.close()

    def test_complete_corruption_is_rejected_before_tail_is_truncated(self):
        journal = RuntimeOperationJournal(self.root / "corrupt")
        try:
            corrupted = self.accepted.replace(b'"sequence":0', b'"sequence":1') + b'{"unfinished":'
            (journal.root / "journal.jsonl").write_bytes(corrupted)
            with self.assertRaises(RuntimeJournalError):
                journal.load()
            self.assertEqual((journal.root / "journal.jsonl").read_bytes(), corrupted)
            self.assertFalse(list(journal.root.glob("interrupted-tail-*.bin")))
        finally:
            journal.close()

    def test_newline_terminated_malformed_record_is_rejected(self):
        journal = RuntimeOperationJournal(self.root / "malformed")
        try:
            (journal.root / "journal.jsonl").write_bytes(self.accepted + b'{"unfinished":\n')
            with self.assertRaises(RuntimeJournalError):
                journal.load()
        finally:
            journal.close()

    def test_interrupted_evidence_copy_does_not_block_tail_recovery(self):
        journal = RuntimeOperationJournal(self.root / "copy-crash")
        try:
            tail = b'{"partial":'
            (journal.root / "journal.jsonl").write_bytes(self.accepted + tail)
            (journal.root / ".interrupted-tail-old.tmp").write_bytes(tail[:2])
            self.assertIsNone(journal.load()[0].response)
            self.assertEqual(list(journal.root.glob("interrupted-tail-*.bin"))[0].read_bytes(), tail)
        finally:
            journal.close()


class RepeatedRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.backend = service_fixture.FakeDockerRuntimeBackend(service_fixture._repository(self.root))
        self.journal_root = self.root / "journal"
        self.service = service_fixture._service(self.backend, self.journal_root)
        self.binding = {"candidate_id": service_fixture.CANDIDATE_ID, "instance_id": service_fixture.INSTANCE_ID}
        self.service.preflight(service_fixture._write_request("runtime_preflight", "a", "a:preflight", **self.binding))
        self.prepare = service_fixture._write_request("runtime_prepare_worker", "a", "a:prepare", **self.binding)
        self.lease = self.service.prepare_worker(self.prepare).response["lease_id"]

    def tearDown(self):
        self.service.close()
        self.temporary.cleanup()

    def restart(self):
        self.service.close()
        self.service = service_fixture._service(self.backend, self.journal_root)

    def test_failed_cleanup_retries_then_unblocks_without_duplicate_recovery(self):
        self.backend.recovery_cleanup = RuntimeCleanupResult(1, 0)
        self.restart()
        self.restart()
        self.assertEqual(self.backend.events.count("recover:a"), 2)
        self.backend.recovery_cleanup = RuntimeCleanupResult(0, 0)
        self.restart()
        self.assertFalse(self.service._recovery_blocked)
        self.assertEqual(self.service._attempts["a"].phase, "recovered")
        self.assertEqual(self.backend.events.count("recover:a"), 3)
        records = (self.journal_root / "journal.jsonl").read_bytes()
        self.restart()
        self.assertEqual(self.backend.events.count("recover:a"), 3)
        self.assertEqual((self.journal_root / "journal.jsonl").read_bytes(), records)
        self.assertTrue(self.service.prepare_worker(self.prepare).replayed)
        with self.assertRaises(RuntimeInvalidState):
            self.service.execute_tool(service_fixture._write_request("runtime_execute_tool", "a", "a:stale",
                lease_id=self.lease, tool="repo_list", input={"path": "."}))
        with self.assertRaises(RuntimeOperationConflict):
            self.service.prepare_worker(service_fixture._write_request("runtime_prepare_worker", "other", "a:prepare", **self.binding))
        self.service.preflight(service_fixture._write_request("runtime_preflight", "b", "b:preflight", **self.binding))
        self.assertEqual(self.service.prepare_worker(service_fixture._write_request(
            "runtime_prepare_worker", "b", "b:prepare", **self.binding)).response["status"], "prepared")

    def test_interrupted_operation_terminal_prevents_repeated_recovery(self):
        pending = service_fixture._write_request("runtime_execute_tool", "a", "a:pending",
            lease_id=self.lease, tool="repo_list", input={"path": "."})
        canonical = dict(pending)
        canonical.pop("request_sha256")
        self.service._journal.begin(canonical, pending["request_sha256"])
        self.restart()
        records = (self.journal_root / "journal.jsonl").read_bytes()
        self.restart()
        self.assertEqual(self.backend.events.count("recover:a"), 1)
        self.assertEqual((self.journal_root / "journal.jsonl").read_bytes(), records)
        with self.assertRaises(RuntimeServiceUnavailable):
            self.service.execute_tool(pending)

    def test_slow_cancellation_does_not_block_another_attempt_registration(self):
        entered, release = Event(), Event()

        def cancel(_attempt):
            entered.set()
            release.wait(2)

        with patch.object(self.backend, "cancel_pending", side_effect=cancel), ThreadPoolExecutor(2) as executor:
            aborted = executor.submit(self.service.abort_attempt,
                service_fixture._write_request("runtime_abort_attempt", "a", "a:abort"))
            try:
                self.assertTrue(entered.wait(1))
                other = executor.submit(self.service.preflight,
                    service_fixture._write_request("runtime_preflight", "b", "b:preflight", **self.binding))
                self.assertEqual(other.result(timeout=1).response["status"], "ready")
            finally:
                release.set()
            self.assertEqual(aborted.result(timeout=1).response["status"], "aborted")


class DockerCancellationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        fixture, self.client, self.candidate = docker_fixture._backend_fixture(self.root)
        self.backend = DockerRuntimeBackend(self.client, fixture._catalog,
            replace(fixture._configuration, worker_pool_capacity=2, evaluator_pool_capacity=1, reuse_containers=True),
            read_only_check=lambda _path: True)
        self.service = RuntimeOperationService(self.backend, RuntimeOperationJournal(self.root / "journal"))

    def tearDown(self):
        self.client.volumes.fail_remove = False
        self.service.close()
        self.temporary.cleanup()

    def worker(self, attempt):
        binding = {"candidate_id": self.candidate.candidate_id, "instance_id": self.candidate.instance_id}
        self.service.preflight(docker_fixture._write_request("runtime_preflight", attempt, f"{attempt}:preflight", **binding))
        self.backend.worker_pool.wait_prepared()
        prepared = self.service.prepare_worker(docker_fixture._write_request(
            "runtime_prepare_worker", attempt, f"{attempt}:prepare", **binding)).response
        return prepared["lease_id"], self.service._attempts[attempt].worker

    def test_cancel_interrupts_active_owner_and_preserves_other_task(self):
        lease, worker = self.worker("cancelled")
        _, other = self.worker("other")
        entered, interrupted = Event(), Event()
        worker.container.kill = lambda: interrupted.set()

        def execute(*_args):
            entered.set()
            if not interrupted.wait(2):
                raise RuntimeDockerError("injected execution deadline")
            raise RuntimeDockerError("execution interrupted")

        with patch.object(self.backend, "execute_tool", side_effect=execute), ThreadPoolExecutor(2) as executor:
            running = executor.submit(self.service.execute_tool, docker_fixture._write_request(
                "runtime_execute_tool", "cancelled", "cancelled:exec", lease_id=lease, tool="repo_list", input={"path": "."}))
            self.assertTrue(entered.wait(2))
            aborted = executor.submit(self.service.abort_attempt, docker_fixture._write_request(
                "runtime_abort_attempt", "cancelled", "cancelled:abort"))
            self.assertEqual(aborted.result(timeout=4).response["status"], "aborted")
            with self.assertRaises(RuntimeServiceUnavailable):
                running.result(timeout=1)
        self.assertTrue(interrupted.is_set())
        self.assertTrue(worker.container.removed)
        self.assertFalse(other.container.removed)
        self.backend.execute_tool(other, "repo_list", {"path": "."})

    def test_failed_interrupt_and_cleanup_keep_charge_until_audited_retry(self):
        _, worker = self.worker("cancelled")
        worker.container.kill = lambda: (_ for _ in ()).throw(RuntimeError("kill failed"))
        self.client.volumes.fail_remove = True
        before = self.backend.resource_admission.snapshot["nano_cpus"]
        self.backend.cancel_pending("cancelled")
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], before)
        self.assertFalse(self.backend.recover_attempt("cancelled").clean)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], before)
        self.client.volumes.fail_remove = False
        self.assertTrue(self.backend.recover_attempt("cancelled").clean)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_000_000_000)

    def test_creation_racing_cancel_is_removed_without_becoming_claimable(self):
        original = self.client.containers.run
        created = []

        def racing_run(*args, **kwargs):
            container = original(*args, **kwargs)
            created.append(container)
            self.backend._interrupt_owner(kwargs["labels"]["io.repofixlab.runtime.attempt-id"])
            return container

        with patch.object(self.client.containers, "run", side_effect=racing_run):
            self.backend.prewarm_worker("racing", self.candidate.candidate_id, self.candidate.instance_id)
            self.backend.worker_pool.wait_prepared()
        self.assertTrue(created)
        self.assertTrue(all(container.removed for container in created))
        self.assertEqual(self.backend.worker_pool.snapshot["ready"], 0)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_000_000_000)

    def test_reset_cancellation_quarantines_owner_and_ends_generation(self):
        lease, worker = self.worker("reset")
        self.service.snapshot_patch(docker_fixture._write_request("runtime_snapshot_patch", "reset", "reset:snapshot", lease_id=lease))
        entered, interrupted = Event(), Event()
        run = self.client.containers.run

        def reset_helper(*args, **kwargs):
            container = run(*args, **kwargs)
            if "reset-helper" in kwargs["name"]:
                container.kill = lambda: interrupted.set()

                def wait(**_kwargs):
                    entered.set()
                    interrupted.wait(2)
                    return {"StatusCode": 137}

                container.wait = wait
            return container

        with patch.object(self.client.containers, "run", side_effect=reset_helper), ThreadPoolExecutor(2) as executor:
            resetting = executor.submit(self.service.destroy_worker, docker_fixture._write_request(
                "runtime_destroy_worker", "reset", "reset:destroy", lease_id=lease))
            self.assertTrue(entered.wait(2))
            aborted = executor.submit(self.service.abort_attempt, docker_fixture._write_request("runtime_abort_attempt", "reset", "reset:abort"))
            self.assertTrue(resetting.result(timeout=4).response["cleanup"]["clean"])
            self.assertTrue(aborted.result(timeout=4).response["cleanup"]["clean"])
        self.assertTrue(interrupted.is_set())
        self.assertTrue(worker.container.removed)
        with self.assertRaisesRegex(RuntimeDockerError, "generation"):
            self.backend.execute_tool(worker, "repo_list", {"path": "."})

    def test_evaluator_oom_has_distinct_failure_class_and_recovery_cleans_it(self):
        lease, _worker = self.worker("oom")
        snapshot = self.service.snapshot_patch(docker_fixture._write_request(
            "runtime_snapshot_patch", "oom", "oom:snapshot", lease_id=lease)).response
        self.service.destroy_worker(docker_fixture._write_request("runtime_destroy_worker", "oom", "oom:destroy", lease_id=lease))
        self.backend.evaluator_pool.wait_prepared()
        response = self.service.start_evaluation(docker_fixture._write_request("runtime_start_evaluation", "oom", "oom:evaluate",
            snapshot_id=snapshot["snapshot_id"], run_id="oom-run")).response
        job = self.service._attempts["oom"].job
        job.container.attrs["State"] = {"Status": "exited", "ExitCode": 137, "OOMKilled": True}
        status = self.service.get_job(response["job_id"])
        self.assertEqual(status["error_class"], "evaluator_oom")
        aborted = self.service.abort_attempt(docker_fixture._write_request("runtime_abort_attempt", "oom", "oom:abort"))
        self.assertTrue(aborted.response["cleanup"]["clean"])

    def test_cancel_parked_resume_interrupts_verification_before_pool_lock_is_released(self):
        lease, worker = self.worker("first")
        self.service.snapshot_patch(docker_fixture._write_request("runtime_snapshot_patch", "first", "first:snapshot", lease_id=lease))
        self.service.destroy_worker(docker_fixture._write_request("runtime_destroy_worker", "first", "first:destroy", lease_id=lease))
        self.service.abort_attempt(docker_fixture._write_request("runtime_abort_attempt", "first", "first:abort"))
        binding = {"candidate_id": self.candidate.candidate_id, "instance_id": self.candidate.instance_id}
        self.service.preflight(docker_fixture._write_request("runtime_preflight", "resumed", "resumed:preflight", **binding))
        entered, interrupted = Event(), Event()
        worker.container.kill = lambda: interrupted.set()

        def held_verification(*_args, **_kwargs):
            entered.set()
            interrupted.wait(2)
            raise RuntimeDockerError("verification interrupted")

        with patch.object(self.backend, "_volume_reset", side_effect=held_verification), ThreadPoolExecutor(2) as executor:
            preparing = executor.submit(self.service.prepare_worker, docker_fixture._write_request(
                "runtime_prepare_worker", "resumed", "resumed:prepare", **binding))
            self.assertTrue(entered.wait(2))
            aborting = executor.submit(self.service.abort_attempt, docker_fixture._write_request(
                "runtime_abort_attempt", "resumed", "resumed:abort"))
            self.assertTrue(aborting.result(timeout=4).response["cleanup"]["clean"])
            with self.assertRaises(RuntimeServiceUnavailable):
                preparing.result(timeout=1)
        self.assertTrue(interrupted.is_set())
        self.assertTrue(worker.container.removed)
        self.assertFalse(self.backend._active_generations)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_000_000_000)


class WarmCancellationTests(unittest.TestCase):
    def test_shared_preparation_survives_until_last_interest_cancels(self):
        entered, interrupted = Event(), Event()
        interrupted_owners = []

        def prepare(owner, _key):
            entered.set()
            interrupted.wait(2)
            raise RuntimeError("preparation interrupted")

        def interrupt(owner):
            interrupted_owners.append(owner)
            interrupted.set()

        pool = WorkerPool(2, 60, reserve=lambda *_args: True, prepare=prepare,
            bind=lambda worker, *_args: worker, cleanup=lambda _owner: True, interrupt=interrupt)
        try:
            pool.offer("a", "environment")
            pool.offer("b", "environment")
            self.assertTrue(entered.wait(2))
            pool.cancel("a", retire_ready=False)
            self.assertFalse(interrupted.is_set())
            pool.cancel("b", wait=True)
            self.assertTrue(interrupted.is_set())
            self.assertEqual(len(interrupted_owners), 1)
            self.assertEqual(pool.snapshot["preparing"], 0)
        finally:
            interrupted.set()
            pool.close()


if __name__ == "__main__":
    unittest.main()
