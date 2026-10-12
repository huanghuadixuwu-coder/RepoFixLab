"""Exercise pool ownership, competing claims, failure cleanup and admission."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from time import monotonic, sleep
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from repofixlab_controller.runtime_admission import RuntimeAdmission, RuntimeAdmissionCancelled
from repofixlab_controller.runtime_docker import DockerRuntimeBackend, RuntimeDockerError
from repofixlab_controller.runtime_journal import RuntimeOperationJournal
from repofixlab_controller.runtime_service import RuntimeInvalidState, RuntimeOperationService, RuntimeResourceNotFound
from repofixlab_controller.runtime_worker_pool import WorkerPool
from test_runtime_docker import _backend_fixture, _write_request


def wait_for(predicate):
    deadline = monotonic() + 3
    while not predicate():
        if monotonic() >= deadline:
            raise AssertionError("pool did not reach its checkpoint")
        sleep(0.005)


class PoolReplacementTests(unittest.TestCase):
    """New environment demand may replace only an unclaimed ready duplicate."""

    def setUp(self):
        self.reserved, self.retired = [], []
        self.pool = WorkerPool(2, 300,
            reserve=lambda owner, key: self.reserved.append((owner, key)) is None,
            prepare=lambda owner, key: SimpleNamespace(attempt_id=owner, generation=0),
            bind=lambda worker, attempt, key: worker,
            cleanup=lambda owner: self.retired.append(owner) is None)
        self.addCleanup(self.pool.close)

    def returned(self, owner, key, *, publish=True):
        worker = SimpleNamespace(attempt_id=owner, resource_owner=owner, generation=1,
                                 container=SimpleNamespace(id=owner), parked=True)
        self.assertTrue(self.pool.recycle(worker, key, lambda value: value))
        if publish:
            self.pool.publish(owner, 1)

    def test_new_environment_replaces_duplicate_after_cleanup_and_preserves_interest(self):
        self.returned("first", "A")
        self.returned("duplicate", "A")
        self.pool.offer("next-A", "A")
        self.pool.offer("next-B", "B")
        self.pool.wait_prepared()
        self.assertEqual(self.retired, ["duplicate"])
        self.assertEqual([key for owner, key in self.reserved], ["B"])
        self.assertIsNotNone(self.pool.take("next-A", "A"))
        self.assertIsNotNone(self.pool.take("next-B", "B"))

    def test_two_known_claims_get_two_environments_after_idle_incompatible_cleanup(self):
        self.returned("first", "A")
        self.returned("unused", "B")
        self.pool.offer("a", "A")
        self.pool.offer("second-A", "A")
        self.pool.wait_prepared()
        self.assertEqual(self.retired, ["unused"])
        self.assertEqual([key for owner, key in self.reserved], ["A"])
        first = self.pool.take("a", "A")
        second = self.pool.take("second-A", "A")
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertIsNot(first, second)

    def test_unique_environments_and_unpublished_returns_are_preserved(self):
        for second_key, published in (("B", True), ("A", False)):
            with self.subTest(second_key=second_key, published=published):
                self.returned("first", "A")
                self.returned("second", second_key, publish=published)
                self.pool.offer(f"next-{second_key}-{published}", "C")
                self.assertFalse(self.reserved)
                self.assertFalse(self.retired)
                self.pool.evict_idle("test_cleanup")
                self.retired.clear()

    def test_failed_victim_cleanup_blocks_replacement_and_retains_capacity(self):
        self.returned("first", "A")
        self.returned("duplicate", "A")
        with patch.object(self.pool, "_cleanup", return_value=False):
            self.pool.offer("next-B", "B")
        self.assertFalse(self.reserved)
        self.assertEqual(self.pool.snapshot["blocked"], 1)
        self.assertEqual(sum(self.pool.snapshot.values()), 2)
        with self.assertRaisesRegex(RuntimeError, "blocked"):
            self.pool.take("next-B", "B")

    def test_cancel_during_duplicate_cleanup_prevents_new_preparation(self):
        self.returned("first", "A")
        self.returned("duplicate", "A")
        entered, release = Event(), Event()
        cleanup = self.pool._cleanup

        def delayed(owner):
            entered.set()
            if not release.wait(3):
                raise AssertionError("cleanup checkpoint not released")
            return cleanup(owner)

        with patch.object(self.pool, "_cleanup", delayed), ThreadPoolExecutor(1) as executor:
            offered = executor.submit(self.pool.offer, "next-B", "B")
            self.assertTrue(entered.wait(3))
            self.assertEqual(sum(self.pool.snapshot.values()), 2)
            self.pool.cancel("next-B")
            release.set()
            offered.result(timeout=3)
        self.assertFalse(self.reserved)
        self.assertEqual(sum(self.pool.snapshot.values()), 1)

    def test_only_one_task_waits_for_preparation_and_cancel_releases_that_waiter(self):
        entered, release = Event(), Event()

        def prepare(owner, key):
            entered.set()
            if not release.wait(3):
                raise AssertionError("preparation checkpoint not released")
            return SimpleNamespace(attempt_id=owner, generation=0)

        with patch.object(self.pool, "_prepare_worker", prepare), ThreadPoolExecutor(1) as executor:
            self.pool.offer("a", "A")
            self.assertTrue(entered.wait(3))
            self.pool.offer("b", "A")
            first = executor.submit(self.pool.take, "a", "A")
            wait_for(lambda: any(entry.waiting_attempt == "a" for entry in self.pool._entries.values()))
            self.assertIsNone(self.pool.take("b", "A", timeout_seconds=0.01))
            self.pool.cancel("a")
            with self.assertRaises(RuntimeAdmissionCancelled):
                first.result(timeout=3)
            release.set()
            self.pool.wait_prepared()
            self.assertIsNotNone(self.pool.take("b", "A"))

    def test_slow_binding_keeps_single_ownership_without_blocking_other_claims(self):
        self.returned("first", "A")
        self.returned("other", "B")
        entered, release = Event(), Event()

        def bind(worker, attempt, key):
            if key == "A":
                entered.set()
                if not release.wait(3):
                    raise AssertionError("binding checkpoint not released")
            return worker

        with patch.object(self.pool, "_bind", bind), ThreadPoolExecutor(1) as executor:
            first = executor.submit(self.pool.take, "a", "A")
            self.assertTrue(entered.wait(3))
            self.assertEqual(self.pool.snapshot["claiming"], 1)
            self.assertIsNone(self.pool.take("competitor", "A"))
            self.assertIsNotNone(self.pool.take("b", "B"))
            release.set()
            self.assertIsNotNone(first.result(timeout=3))


class WorkerPoolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        fixture, self.client, self.candidate = _backend_fixture(self.root)
        self.backend = DockerRuntimeBackend(
            self.client, fixture._catalog,
            replace(fixture._configuration, worker_pool_capacity=2),
            read_only_check=lambda _path: True,
        )
        self.service = RuntimeOperationService(self.backend, RuntimeOperationJournal(self.root / "journal"))
        self.pool = self.backend.worker_pool

    def tearDown(self):
        self.client.volumes.fail_remove = False
        self.service.close()
        self.temporary.cleanup()

    def preflight(self, attempt):
        return self.service.preflight(_write_request(
            "runtime_preflight", attempt, f"{attempt}:preflight",
            candidate_id=self.candidate.candidate_id, instance_id=self.candidate.instance_id,
        ))

    def prepare(self, attempt):
        return self.service.prepare_worker(_write_request(
            "runtime_prepare_worker", attempt, f"{attempt}:prepare",
            candidate_id=self.candidate.candidate_id, instance_id=self.candidate.instance_id,
        ))

    def abort(self, attempt):
        return self.service.abort_attempt(_write_request("runtime_abort_attempt", attempt, f"{attempt}:abort"))

    def test_same_environment_merges_and_competing_claims_get_unique_leases(self):
        for attempt in ("a", "b"):
            self.preflight(attempt)
        self.pool.wait_prepared()
        self.assertEqual(self.pool.snapshot["ready"], 1)
        self.assertEqual(len(self.client.containers.created), 1)
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(self.prepare, ("a", "b")))
        workers = [self.service._attempts[attempt].worker for attempt in ("a", "b")]
        self.assertNotEqual(results[0].response["lease_id"], results[1].response["lease_id"])
        self.assertNotEqual(workers[0].container.id, workers[1].container.id)
        self.assertEqual(sum(event["event"] == "hit" for event in self.pool.records), 1)
        self.assertEqual(sum(event["event"] == "miss" for event in self.pool.records), 1)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 2)
        self.assertEqual(self.backend.resource_admission.snapshot["memory_bytes"],
                         2 * self.candidate.definition.worker.memory_bytes + 512 * 1024**2)
        self.assertTrue(self.prepare("a").replayed)
        for attempt in ("a", "b"):
            self.assertTrue(self.abort(attempt).response["cleanup"]["clean"])
        self.assertTrue(all(worker.container.removed for worker in workers))
        with self.assertRaises(RuntimeResourceNotFound):
            self.service.execute_tool(_write_request(
                "runtime_execute_tool", "a", "stale", lease_id=results[0].response["lease_id"],
                tool="repo_list", input={"path": "."},
            ))
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_incompatible_task_is_rejected_before_claim(self):
        self.preflight("a")
        self.pool.wait_prepared()
        with self.assertRaises(RuntimeDockerError):
            self.backend.prepare_worker("b", self.candidate.candidate_id, "untrusted__task")
        self.assertEqual(self.pool.snapshot["ready"], 1)
        self.assertFalse(self.client.containers.created[0].removed)

    def test_claim_rechecks_actual_image_security_and_helper_identity(self):
        for field in ("Image", "helper"):
            with self.subTest(field=field):
                attempt = f"bad-{field}"
                self.preflight(attempt)
                self.pool.wait_prepared()
                container = self.client.containers.created[-1]
                if field == "Image":
                    container.attrs["Image"] = "sha256:" + "0" * 64
                else:
                    container.files["/tmp/repofixlab-runtime-worker/runtime_tools.py"] = b"changed"
                with self.assertRaisesRegex(RuntimeError, "claim"):
                    self.backend.prepare_worker(attempt, self.candidate.candidate_id, self.candidate.instance_id)
                self.assertTrue(container.removed)
                self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_idle_expiry_reclaims_resources_without_a_new_request(self):
        self.pool._idle_seconds = 0.02
        self.preflight("expire")
        self.pool.wait_prepared()
        wait_for(lambda: any(event["event"] == "retired" for event in self.pool.records))
        self.assertEqual(sum(self.pool.snapshot.values()), 0)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertTrue(all(volume.removed for volume in self.client.volumes.created))
        self.assertFalse(self.client.volumes.private.removed)

    def test_cancel_preparing_one_interest_preserves_the_other(self):
        entered, release = Event(), Event()
        create = self.backend._create_worker

        def delayed(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError("test did not release preparation")
            return create(*args)

        with patch.object(self.backend, "_create_worker", delayed):
            self.preflight("a")
            self.assertTrue(entered.wait(3))
            self.preflight("b")
            self.assertTrue(self.abort("a").response["cleanup"]["clean"])
            self.assertEqual(self.backend.resource_admission.snapshot["active"], 1)
            release.set()
            self.pool.wait_prepared()
            self.prepare("b")
            self.assertTrue(self.abort("b").response["cleanup"]["clean"])

    def test_cancel_last_interest_waits_for_inflight_cleanup(self):
        entered, release = Event(), Event()
        create = self.backend._create_worker

        def delayed(*args):
            entered.set()
            release.wait(3)
            return create(*args)

        with patch.object(self.backend, "_create_worker", delayed):
            self.preflight("a")
            self.assertTrue(entered.wait(3))
            with ThreadPoolExecutor(1) as executor:
                aborted = executor.submit(self.abort, "a")
                wait_for(lambda: "a" in self.pool._cancelled)
                self.assertFalse(aborted.done())
                release.set()
                self.assertTrue(aborted.result(timeout=3).response["cleanup"]["clean"])
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertTrue(all(container.removed for container in self.client.containers.created))

    def test_cancel_during_claim_preserves_cancellation_and_cleans_resources(self):
        self.preflight("a")
        self.pool.wait_prepared()
        entered, release = Event(), Event()
        transfer = self.backend.resource_admission.transfer

        def delayed(owner, attempt):
            entered.set()
            if not release.wait(3):
                raise AssertionError("test did not release claim")
            transfer(owner, attempt)

        with patch.object(self.backend.resource_admission, "transfer", delayed):
            with ThreadPoolExecutor(2) as executor:
                prepared = executor.submit(self.prepare, "a")
                self.assertTrue(entered.wait(3))
                aborted = executor.submit(self.abort, "a")
                wait_for(lambda: "a" in self.backend.resource_admission._cancelled)
                release.set()
                with self.assertRaisesRegex(RuntimeInvalidState, "runtime_queue_cancelled"):
                    prepared.result(timeout=3)
                self.assertTrue(aborted.result(timeout=3).response["cleanup"]["clean"])
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertTrue(all(container.removed for container in self.client.containers.created))

    def test_shutdown_cleans_an_active_cold_fallback(self):
        with self.pool.demand():
            self.preflight("cold")
        self.prepare("cold")
        worker = self.service._attempts["cold"].worker
        self.assertIsNone(worker.resource_owner)
        self.service.close()
        self.assertTrue(worker.container.removed)
        self.assertTrue(all(volume.removed for volume in worker.volumes))
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_preparation_failure_cleans_and_cold_fallback_stays_available(self):
        with patch.object(self.backend, "_check_worker_ready", side_effect=RuntimeDockerError("injected")):
            self.preflight("a")
            wait_for(lambda: any(event["event"] == "retired" for event in self.pool.records))
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertEqual(self.pool.snapshot["ready"], 0)
        self.assertEqual(self.prepare("a").response["status"], "prepared")
        self.assertTrue(self.abort("a").response["cleanup"]["clean"])

    def test_ready_rejects_dirty_worktree_and_wrong_base_commit(self):
        execute = self.backend._exec_json
        for identity in ({"base_commit": self.candidate.base_commit, "clean": False},
                         {"base_commit": "0" * 40, "clean": True}):
            def drifted(container, command, **kwargs):
                if len(command) == 3 and "git('status'" in command[2]:
                    return identity
                return execute(container, command, **kwargs)

            attempt = f"drift-{len(self.client.containers.created)}"
            with patch.object(self.backend, "_exec_json", drifted):
                self.preflight(attempt)
                wait_for(lambda: any(event["event"] == "prepare_failed" and "workspace" in event["error_message"]
                                     for event in self.pool.records) and sum(self.pool.snapshot.values()) == 0)
            self.assertTrue(self.client.containers.created[-1].removed)
            self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_cleanup_failure_keeps_reservation_and_blocks_claims_until_retry(self):
        self.preflight("a")
        self.pool.wait_prepared()
        self.client.volumes.fail_remove = True
        with self.assertRaisesRegex(RuntimeError, "residual"):
            self.pool.evict_idle()
        self.assertEqual(self.pool.snapshot["blocked"], 1)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 1)
        with self.assertRaisesRegex(RuntimeError, "blocked"):
            self.backend.prepare_worker("b", self.candidate.candidate_id, self.candidate.instance_id)
        self.client.volumes.fail_remove = False
        self.pool.evict_idle("retry")
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_speculation_yields_to_demand_and_budget(self):
        self.backend.resource_admission.acquire("evaluator", 6_000_000_000, 18 * 1024**3 - 512 * 1024**2)
        self.preflight("a")
        self.assertEqual(sum(self.pool.snapshot.values()), 0)
        self.assertEqual(self.client.containers.created, [])
        self.backend.resource_admission.release("evaluator")
        self.preflight("b")
        self.pool.wait_prepared()
        with self.pool.demand():
            self.preflight("c")
            self.assertEqual(sum(self.pool.snapshot.values()), 0)
            self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertTrue(all(container.removed for container in self.client.containers.created))

    def test_atomic_transfer_preserves_charge_and_rejects_cancelled_lease(self):
        admission = RuntimeAdmission(10, 20)
        self.assertTrue(admission.try_acquire("warm", 4, 8))
        self.assertFalse(admission.try_acquire("oversize", 10, 21))
        admission.cancel("cancelled")
        with self.assertRaises(RuntimeAdmissionCancelled):
            admission.transfer("warm", "cancelled")
        self.assertEqual(admission.snapshot["active"], 1)
        admission.transfer("warm", "a")
        self.assertEqual(admission.snapshot, {"active": 1, "waiting": 0, "nano_cpus": 4, "memory_bytes": 8})

    def test_namespace_is_durable_and_independent_of_container_mount_path(self):
        identity = self.service._journal.pool_namespace()
        other = RuntimeOperationJournal(self.root / "other-journal")
        other_identity = other.pool_namespace()
        self.assertNotEqual(identity, other_identity)
        other.close()
        reopened = RuntimeOperationJournal(self.root / "other-journal")
        try:
            self.assertEqual(reopened.pool_namespace(), other_identity)
        finally:
            reopened.close()

    def test_startup_cleans_only_this_journals_pool_namespace(self):
        self.preflight("a")
        self.pool.wait_prepared()
        physical = self.client.containers.created[0]
        foreign = self.client.volumes.create(name="foreign", labels={
            "io.repofixlab.runtime.managed": "true", "io.repofixlab.runtime.worker-pool": "other",
            "io.repofixlab.runtime.attempt-id": "foreign-owner",
        })
        # Simulate process loss after physical readiness, before a claim.
        self.pool._stop.set()
        self.pool._sweeper.join()
        self.pool._executor.shutdown(wait=True)
        self.service._journal.close()
        replacement = DockerRuntimeBackend(self.client, self.backend._catalog, self.backend._configuration,
                                           read_only_check=lambda _path: True)
        self.service = RuntimeOperationService(replacement, RuntimeOperationJournal(self.root / "journal"))
        self.assertTrue(physical.removed)
        self.assertFalse(foreign.removed)
        self.assertEqual(replacement.resource_admission.snapshot["active"], 0)


if __name__ == "__main__":
    unittest.main()
