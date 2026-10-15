"""Race the production admission, request ordering and durable journal paths."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Event
from time import monotonic, sleep
import unittest

from test_runtime_service import (
    BASE_COMMIT, CANDIDATE_ID, INSTANCE_ID, FakeDockerRuntimeBackend,
    _repository, _write_request,
)
from repofixlab_controller.runtime_admission import (
    RuntimeAdmission, RuntimeAdmissionCancelled,
)
from repofixlab_controller.runtime_journal import RuntimeOperationJournal, runtime_request_sha256
from repofixlab_controller.runtime_service import (
    RuntimeCapacityBusy, RuntimeInvalidState, RuntimeOperationService,
)


def wait_for(predicate) -> None:
    deadline = monotonic() + 3
    while not predicate():
        if monotonic() >= deadline:
            raise AssertionError("concurrent operation did not reach its checkpoint")
        sleep(0.005)


def preflight(service, attempt):
    return service.preflight(_write_request(
        "runtime_preflight", attempt, f"{attempt}:preflight",
        candidate_id=CANDIDATE_ID, instance_id=INSTANCE_ID,
    ))


def prepare(service, attempt):
    return service.prepare_worker(_write_request(
        "runtime_prepare_worker", attempt, f"{attempt}:prepare",
        candidate_id=CANDIDATE_ID, instance_id=INSTANCE_ID,
    ))


def abort(service, attempt):
    return service.abort_attempt(_write_request("runtime_abort_attempt", attempt, f"{attempt}:abort"))


class RuntimeConcurrencyTest(unittest.TestCase):
    def test_two_attempts_prepare_concurrently_and_replay_once(self):
        barrier = Barrier(2)

        class Backend(FakeDockerRuntimeBackend):
            def prepare_worker(self, *args):
                barrier.wait(timeout=3)
                return super().prepare_worker(*args)

        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = Backend(_repository(root))
            journal = RuntimeOperationJournal(root / "journal")
            service = RuntimeOperationService(backend, journal, capacity=2)
            try:
                for attempt in ("a", "b"):
                    self.assertEqual(preflight(service, attempt).response["manifest"]["capacity"], 2)
                with ThreadPoolExecutor(2) as pool:
                    futures = [pool.submit(prepare, service, attempt) for attempt in ("a", "b")]
                    responses = [future.result(timeout=5) for future in futures]
                self.assertEqual(len(backend.workers), 2)
                self.assertNotEqual(responses[0].response["lease_id"], responses[1].response["lease_id"])
                self.assertTrue(prepare(service, "a").replayed)
                self.assertEqual(sum(event.startswith("worker.prepare:") for event in backend.events), 2)
                self.assertTrue(all(operation.response is not None for operation in journal.load()))
                for attempt in ("a", "b"):
                    abort(service, attempt)
            finally:
                service.close()

    def test_same_attempt_writes_follow_registration_order(self):
        entered, release = Event(), Event()

        class Backend(FakeDockerRuntimeBackend):
            def execute_tool(self, worker, tool, arguments):
                if tool == "repo_list":
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError("test did not release the first operation")
                return super().execute_tool(worker, tool, arguments)

        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = Backend(_repository(root))
            service = RuntimeOperationService(backend, RuntimeOperationJournal(root / "journal"))
            try:
                preflight(service, "a")
                lease = prepare(service, "a").response["lease_id"]
                with ThreadPoolExecutor(3) as pool:
                    first = pool.submit(service.execute_tool, _write_request(
                        "runtime_execute_tool", "a", "a:list", lease_id=lease, tool="repo_list", input={"path": "."}))
                    self.assertTrue(entered.wait(3))
                    second = pool.submit(service.execute_tool, _write_request(
                        "runtime_execute_tool", "a", "a:edit", lease_id=lease, tool="repo_edit",
                        input={"path": "new.txt", "content": "ordered\n"}))
                    wait_for(lambda: "a:edit" in service._operations)
                    third = pool.submit(service.snapshot_patch, _write_request(
                        "runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease))
                    wait_for(lambda: "a:snapshot" in service._operations)
                    release.set()
                    first.result(timeout=3)
                    second.result(timeout=3)
                    snapshot = third.result(timeout=3).response
                self.assertFalse(snapshot["empty"])
                self.assertEqual(snapshot["base_commit"], BASE_COMMIT)
                operations = [event for event in backend.events if event.startswith(("tool:", "worker.snapshot:"))]
                self.assertEqual(operations, ["tool:a:repo_list", "tool:a:repo_edit", "worker.snapshot:a"])
                abort(service, "a")
            finally:
                release.set()
                service.close()

    def test_queue_is_bounded_and_cancelling_waiter_preserves_active_worker(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = FakeDockerRuntimeBackend(_repository(root))
            service = RuntimeOperationService(backend, RuntimeOperationJournal(root / "journal"),
                                              capacity=1, max_waiting=1)
            try:
                for attempt in ("a", "b", "c"):
                    preflight(service, attempt)
                prepare(service, "a")
                original = backend.workers["a"]
                with ThreadPoolExecutor(1) as pool:
                    waiting = pool.submit(prepare, service, "b")
                    wait_for(lambda: service._capacity.snapshot["waiting"] == 1)
                    with self.assertRaisesRegex(RuntimeCapacityBusy, "runtime_queue_full"):
                        prepare(service, "c")
                    self.assertEqual(abort(service, "b").response["status"], "aborted")
                    with self.assertRaisesRegex(RuntimeInvalidState, "runtime_queue_cancelled"):
                        waiting.result(timeout=3)
                self.assertIs(backend.workers["a"], original)
                self.assertEqual(service._capacity.snapshot["active"], 1)
                self.assertEqual(service._capacity.snapshot["waiting"], 0)
                abort(service, "a")
                self.assertEqual(prepare(service, "c").response["status"], "prepared")
                abort(service, "c")
            finally:
                service.close()

    def test_capacity_timeout_starts_no_extra_worker(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = FakeDockerRuntimeBackend(_repository(root))
            service = RuntimeOperationService(backend, RuntimeOperationJournal(root / "journal"),
                                              capacity=1, max_waiting=1, queue_timeout_seconds=0.02)
            try:
                preflight(service, "a")
                prepare(service, "a")
                preflight(service, "b")
                with self.assertRaisesRegex(RuntimeCapacityBusy, "runtime_queue_timeout"):
                    prepare(service, "b")
                self.assertEqual(set(backend.workers), {"a"})
                self.assertEqual(service._capacity.snapshot["waiting"], 0)
                abort(service, "a")
            finally:
                service.close()

    def test_abort_interrupts_backend_resource_wait_and_replays_its_cancellation(self):
        gib = 1024**3

        class Backend(FakeDockerRuntimeBackend):
            def __init__(self, repository):
                super().__init__(repository)
                self.admission = RuntimeAdmission(10_000_000_000, 9 * gib)

            def prepare_worker(self, attempt_id, candidate_id, instance_id):
                self.admission.acquire(attempt_id, 4_000_000_000, 8 * gib)
                return super().prepare_worker(attempt_id, candidate_id, instance_id)

            def cancel_pending(self, attempt_id):
                self.admission.cancel(attempt_id)

            def recover_attempt(self, attempt_id):
                cleanup = super().recover_attempt(attempt_id)
                if cleanup.clean:
                    self.admission.release(attempt_id)
                return cleanup

        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = Backend(_repository(root))
            journal = RuntimeOperationJournal(root / "journal")
            service = RuntimeOperationService(backend, journal, capacity=2)
            try:
                for attempt in ("a", "b"):
                    preflight(service, attempt)
                prepare(service, "a")
                with ThreadPoolExecutor(1) as pool:
                    waiting = pool.submit(prepare, service, "b")
                    wait_for(lambda: backend.admission.snapshot["waiting"] == 1)
                    abort(service, "b")
                    with self.assertRaisesRegex(RuntimeInvalidState, "runtime_queue_cancelled"):
                        waiting.result(timeout=3)
                with self.assertRaisesRegex(RuntimeInvalidState, "runtime_queue_cancelled"):
                    prepare(service, "b")
                self.assertEqual(set(backend.workers), {"a"})
                self.assertEqual(backend.admission.snapshot["memory_bytes"], 8 * gib)
                cancellation = next(operation for operation in journal.load()
                                    if operation.request["operation_id"] == "b:prepare")
                self.assertEqual(cancellation.response["error_class"], "runtime_queue_cancelled")
                abort(service, "a")
            finally:
                service.close()

    def test_parallel_journal_appends_recover_a_contiguous_hash_chain(self):
        with TemporaryDirectory() as temporary:
            journal = RuntimeOperationJournal(Path(temporary).resolve())

            def write(index):
                body = {"schema_version": "v1", "request_type": "runtime_test",
                        "attempt_id": f"attempt-{index}", "operation_id": f"operation-{index}"}
                digest = runtime_request_sha256(body)
                journal.begin(body, digest)
                journal.finish(body, digest, {**body, "request_sha256": digest,
                                              "response_type": "runtime_test", "status": "completed"})

            try:
                with ThreadPoolExecutor(8) as pool:
                    list(pool.map(write, range(40)))
                operations = journal.load()
                self.assertEqual(len(operations), 40)
                self.assertTrue(all(operation.response is not None for operation in operations))
                lines = [json.loads(line) for line in (journal.root / "journal.jsonl").read_text().splitlines()]
                self.assertEqual([line["sequence"] for line in lines], list(range(80)))
            finally:
                journal.close()

    def test_complete_stage_peaks_wait_and_cancel_without_releasing_active_resources(self):
        gib = 1024**3
        admission = RuntimeAdmission(10_000_000_000, 18 * gib,
                                     baseline_nano_cpus=1_000_000_000, baseline_memory_bytes=gib // 2)
        admission.acquire("worker-a", 4_000_000_000, 8 * gib)
        admission.acquire("worker-b", 4_000_000_000, 8 * gib)
        self.assertEqual(admission.snapshot["memory_bytes"], 16 * gib + gib // 2)
        with ThreadPoolExecutor(1) as pool:
            admission.release("worker-a")
            evaluator = pool.submit(admission.acquire, "evaluator", 6_000_000_000, 12 * gib)
            wait_for(lambda: admission.snapshot["waiting"] == 1)
            self.assertFalse(evaluator.done())
            admission.release("worker-b")
            evaluator.result(timeout=3)
            worker = pool.submit(admission.acquire, "worker-c", 4_000_000_000, 8 * gib)
            wait_for(lambda: admission.snapshot["waiting"] == 1)
            admission.cancel("worker-c")
            with self.assertRaises(RuntimeAdmissionCancelled):
                worker.result(timeout=3)
        self.assertEqual(admission.snapshot["active"], 1)
        self.assertEqual(admission.snapshot["memory_bytes"], 12 * gib + gib // 2)
        admission.release("evaluator")
        self.assertEqual(admission.snapshot["active"], 0)


if __name__ == "__main__":
    unittest.main()
