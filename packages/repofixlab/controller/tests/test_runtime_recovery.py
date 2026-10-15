"""Exercise the confirmed waits, one-retry rules, and result/resource ownership."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import base64
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
import unittest
from unittest.mock import Mock, patch

from repofixlab_controller.runtime_admission import RuntimeAdmissionCancelled
from repofixlab_controller.runtime_docker import DockerRuntimeBackend, RuntimeDockerError
from repofixlab_controller.runtime_journal import RuntimeOperationJournal
from repofixlab_controller.runtime_tools import RuntimeVerificationCatalog
from repofixlab_controller.runtime_service import (RuntimeCleanupResult, RuntimeInvalidState, RuntimeJobStatus,
    RuntimeOperationService, RuntimeRequestRejected, RuntimeResourceNotFound, RuntimeServiceUnavailable)
from test_runtime_docker import _backend_fixture, _write_request


class RuntimeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.backend, self.client, self.candidate = _backend_fixture(self.root)
        self.service = RuntimeOperationService(self.backend, RuntimeOperationJournal(self.root / "journal"))

    def tearDown(self):
        # Remove intentionally quarantined fixture resources as an operator.
        self.client.volumes.fail_remove = False
        for container in self.client.containers.created:
            container.removed = True
        for volume in self.client.volumes.created:
            volume.remove(force=True)
        self.service.close()
        self.temporary.cleanup()

    def worker(self, attempt="a"):
        self.service.preflight(_write_request("runtime_preflight", attempt, f"{attempt}:preflight",
            candidate_id=self.candidate.candidate_id, instance_id=self.candidate.instance_id))
        response = self.service.prepare_worker(_write_request("runtime_prepare_worker", attempt, f"{attempt}:prepare",
            candidate_id=self.candidate.candidate_id, instance_id=self.candidate.instance_id))
        return response.response["lease_id"]

    def evaluation(self):
        lease = self.worker()
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease))
        self.service.destroy_worker(_write_request("runtime_destroy_worker", "a", "a:destroy", lease_id=lease))
        response = self.service.start_evaluation(_write_request("runtime_start_evaluation", "a", "a:evaluate",
            snapshot_id=snapshot.response["snapshot_id"], run_id="run-a"))
        return response.response["job_id"], snapshot

    def test_docker_wait_is_shared_and_recovers_without_dispatching_work(self):
        self.client.ping = Mock(side_effect=[RuntimeError("offline"), True])
        with patch("repofixlab_controller.runtime_docker._DOCKER_POLL_SECONDS", 0.01), ThreadPoolExecutor(2) as executor:
            futures = [executor.submit(self.backend.wait_available, attempt) for attempt in ("a", "b")]
            for future in futures:
                future.result(timeout=2)
        self.assertEqual(self.client.ping.call_count, 2)
        self.assertFalse(self.client.containers.created)

    def test_docker_timeout_blocks_and_does_not_restart_polling(self):
        self.client.ping = Mock(side_effect=RuntimeError("offline"))
        with patch("repofixlab_controller.runtime_docker._DOCKER_POLL_SECONDS", 0.005), \
                patch("repofixlab_controller.runtime_docker._DOCKER_WAIT_SECONDS", 0.02):
            with self.assertRaises(RuntimeServiceUnavailable) as caught:
                self.service.preflight(_write_request("runtime_preflight", "a", "a:preflight",
                    candidate_id=self.candidate.candidate_id, instance_id=self.candidate.instance_id))
            self.assertEqual(caught.exception.reason_code, "runtime_docker_blocked")
            self.assertEqual(self.service._attempts["a"].phase, "blocked")
            probes = self.client.ping.call_count
            with self.assertRaises(RuntimeServiceUnavailable):
                self.backend.wait_available("b", force=True)
        self.assertEqual(self.client.ping.call_count, probes)
        self.assertFalse(self.client.containers.created)

    def test_cancellation_wakes_docker_wait(self):
        entered = Event()

        def offline():
            entered.set()
            raise RuntimeError("offline")

        self.client.ping = offline
        with ThreadPoolExecutor(1) as executor:
            waiting = executor.submit(self.backend.wait_available, "a")
            self.assertTrue(entered.wait(1))
            self.backend.cancel_pending("a")
            with self.assertRaises(RuntimeAdmissionCancelled):
                waiting.result(timeout=1)

    def test_image_drift_and_configuration_error_block_before_creation(self):
        self.client.images.failure = "provenance"
        with self.assertRaises(RuntimeServiceUnavailable) as caught:
            self.service.preflight(_write_request("runtime_preflight", "a", "a:preflight",
                candidate_id=self.candidate.candidate_id, instance_id=self.candidate.instance_id))
        self.assertEqual(caught.exception.reason_code, "runtime_image_blocked")
        self.assertEqual(self.service._attempts["a"].phase, "blocked")
        with self.assertRaises(RuntimeServiceUnavailable) as caught:
            self.service.preflight(_write_request("runtime_preflight", "b", "b:preflight",
                candidate_id=self.candidate.candidate_id, instance_id="unknown__task"))
        self.assertEqual(caught.exception.reason_code, "runtime_configuration_blocked")
        self.assertFalse(self.client.containers.created)

    def test_snapshot_retries_once_and_replay_uses_the_committed_result(self):
        lease = self.worker()
        execute = self.backend._exec_json
        snapshots = []

        def fail_once(container, command, **options):
            if command[-1] == "snapshot":
                snapshots.append(command)
                if len(snapshots) == 1:
                    raise RuntimeDockerError("snapshot interrupted", reason_code="runtime_snapshot_failed")
            return execute(container, command, **options)

        request = _write_request("runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease)
        with patch.object(self.backend, "_exec_json", fail_once):
            snapshot = self.service.snapshot_patch(request)
            replay = self.service.snapshot_patch(request)
        self.assertEqual(len(snapshots), 2)
        self.assertTrue(replay.replayed)
        self.assertEqual(snapshot.response, replay.response)
        self.assertFalse(self.service._attempts["a"].worker.container.removed)

    def test_snapshot_second_failure_stops_and_failed_replay_does_not_execute(self):
        lease = self.worker()
        error = RuntimeDockerError("snapshot interrupted", reason_code="runtime_snapshot_failed")
        request = _write_request("runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease)
        with patch.object(self.backend, "_exec_json", side_effect=error) as execute:
            for _ in range(2):
                with self.assertRaises(RuntimeServiceUnavailable):
                    self.service.snapshot_patch(request)
        self.assertEqual(execute.call_count, 2)
        self.assertEqual(self.service._attempts["a"].phase, "worker_active")

    def test_snapshot_identity_failure_is_not_retried(self):
        lease = self.worker()
        with patch.object(self.backend, "_exec_json", return_value={"wrong": "identity"}) as execute:
            with self.assertRaises(RuntimeServiceUnavailable):
                self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease))
        self.assertEqual(execute.call_count, 1)

    def test_evaluator_retries_same_patch_once_and_records_original_failure(self):
        job_id, snapshot = self.evaluation()
        original = self.service._attempts["a"].job
        original.container.attrs["State"] = {"Status": "exited", "ExitCode": 143}
        start = self.backend.start_evaluation
        with patch.object(self.backend, "start_evaluation", wraps=start) as restarted:
            result = self.service.get_job(job_id)
            again = self.service.get_job(job_id)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result, again)
        self.assertEqual(restarted.call_count, 1)
        self.assertEqual(restarted.call_args.args[-1], self.service._attempts["a"].patch)
        self.assertEqual(snapshot.response["patch_sha256"], self.service._attempts["a"].snapshot_id.removeprefix("snapshot-"))
        self.assertTrue(original.container.removed)
        self.assertNotEqual(original.container.id, self.service._attempts["a"].job.container.id)
        recoveries = [operation for operation in self.service._journal.load()
                      if operation.request["request_type"] == "runtime_retry_evaluation"]
        self.assertEqual(len(recoveries), 1)
        self.assertEqual(recoveries[0].response["reason_code"], "evaluator_process_failed")

    def test_evaluator_second_failure_does_not_start_a_third_job(self):
        job_id, _ = self.evaluation()
        failure = RuntimeJobStatus("failed", False, "evaluator_process_failed")
        with patch.object(self.backend, "get_job", return_value=failure), \
                patch.object(self.backend, "start_evaluation", wraps=self.backend.start_evaluation) as restarted:
            self.assertEqual(self.service.get_job(job_id)["status"], "failed")
            self.assertEqual(self.service.get_job(job_id)["status"], "failed")
        self.assertEqual(restarted.call_count, 1)
        self.assertEqual(self.service._attempts["a"].evaluation_retries, 1)

    def test_evaluator_unresolved_is_a_completed_result(self):
        job_id, _ = self.evaluation()
        with patch.object(self.backend, "get_job", return_value=RuntimeJobStatus("completed", False, None)), \
                patch.object(self.backend, "start_evaluation") as restarted:
            self.assertEqual(self.service.get_job(job_id)["resolved"], False)
        restarted.assert_not_called()

    def test_evaluator_cleanup_failure_prevents_re_evaluation(self):
        job_id, _ = self.evaluation()
        with patch.object(self.backend, "get_job", return_value=RuntimeJobStatus("failed", False, "evaluator_process_failed")), \
                patch.object(self.backend, "discard_evaluation", return_value=RuntimeCleanupResult(1, 1, ("remove_failed",))), \
                patch.object(self.backend, "start_evaluation") as restarted:
            with self.assertRaises(RuntimeServiceUnavailable) as caught:
                self.service.get_job(job_id)
        self.assertEqual(caught.exception.reason_code, "runtime_cleanup_blocked")
        restarted.assert_not_called()

    def test_container_removal_retries_once_and_quarantine_keeps_reservation(self):
        self.worker()
        worker = self.service._attempts["a"].worker
        with patch.object(worker.container, "remove", side_effect=RuntimeError("remove failed")) as remove:
            cleanup = self.backend.destroy_worker(worker)
            again = self.backend._recover_resources("a")
        self.assertFalse(cleanup.clean)
        self.assertFalse(again.clean)
        self.assertEqual(remove.call_count, 2)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 1)
        self.assertIn("a", self.backend._quarantined_owners)

    def test_transient_container_removal_failure_releases_after_retry(self):
        self.worker()
        worker = self.service._attempts["a"].worker
        remove = worker.container.remove
        attempts = []

        def fail_once(**options):
            attempts.append(options)
            if len(attempts) == 1:
                raise RuntimeError("remove failed")
            return remove(**options)

        with patch.object(worker.container, "remove", fail_once):
            self.assertTrue(self.backend.destroy_worker(worker).clean)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_reset_failure_destroys_worker_and_preserves_its_snapshot(self):
        self.service.close()
        self.backend = DockerRuntimeBackend(self.client, self.backend._catalog,
            replace(self.backend._configuration, worker_pool_capacity=1, evaluator_pool_capacity=1,
                    reuse_containers=True), read_only_check=lambda _path: True)
        self.service = RuntimeOperationService(self.backend, RuntimeOperationJournal(self.root / "reuse-journal"))
        lease = self.worker()
        worker = self.service._attempts["a"].worker
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease))
        with patch.object(self.backend, "_volume_reset", side_effect=RuntimeDockerError("reset failed")) as reset:
            result = self.service.destroy_worker(_write_request("runtime_destroy_worker", "a", "a:destroy", lease_id=lease))
        self.assertTrue(result.response["cleanup"]["clean"])
        self.assertTrue(worker.container.removed)
        self.assertEqual(reset.call_count, 1)
        self.assertEqual(self.service._attempts["a"].snapshot_id, snapshot.response["snapshot_id"])
        self.assertEqual(self.service._attempts["a"].phase, "worker_destroyed")

    def interrupt_worker(self, lease, attempt="a", operation="exit"):
        self.service._attempts[attempt].worker.container.attrs["State"] = {"Status": "exited", "ExitCode": 137}
        with self.assertRaises(RuntimeServiceUnavailable) as caught:
            self.service.execute_tool(_write_request("runtime_execute_tool", attempt, f"{attempt}:{operation}",
                lease_id=lease, tool="repo_list", input={}))
        self.assertEqual(caught.exception.reason_code, "runtime_worker_exited")

    def test_worker_restores_sealed_checkpoint_once_and_replays_new_lease(self):
        lease = self.worker()
        old = self.service._attempts["a"].worker
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "a", "a:checkpoint", lease_id=lease))
        self.interrupt_worker(lease)
        request = _write_request("runtime_restore_worker", "a", "a:restore",
            lease_id=lease, snapshot_id=snapshot.response["snapshot_id"])
        capture = self.backend.snapshot_patch
        captures = []

        def fail_first_restored_snapshot(worker):
            captures.append(worker)
            if len(captures) == 1:
                raise RuntimeDockerError("snapshot interrupted", reason_code="runtime_snapshot_failed")
            return capture(worker)

        with patch.object(self.backend, "_exec_text", return_value="") as apply, \
                patch.object(self.backend, "snapshot_patch", side_effect=fail_first_restored_snapshot), \
                patch.object(self.backend, "verification_catalog", return_value=RuntimeVerificationCatalog(
                    catalog_id="catalog-fixture", source_sha256="a" * 64, entries=())):
            restored = self.service.restore_worker(request)
        self.assertEqual(len(captures), 2)
        self.assertEqual([call.args[1][3:] for call in apply.call_args_list],
                         [["apply", "--check", "/tmp/repofixlab-checkpoint.patch"],
                          ["apply", "/tmp/repofixlab-checkpoint.patch"]])
        replay = self.service.restore_worker(request)
        self.assertTrue(replay.replayed)
        self.assertEqual(restored.response, replay.response)
        self.assertTrue(old.container.removed)
        self.assertNotEqual(old.container.id, self.service._attempts["a"].worker.container.id)
        replacement_lease = restored.response["lease_id"]
        self.assertNotEqual(lease, replacement_lease)
        self.assertEqual(self.service._attempts["a"].patch, base64.b64decode(snapshot.response["patch_base64"]))
        self.assertEqual(self.service._attempts["a"].worker.container.files["/tmp/repofixlab-checkpoint.patch"],
                         self.service._attempts["a"].patch)
        with self.assertRaises(RuntimeResourceNotFound):
            self.service.execute_tool(_write_request("runtime_execute_tool", "a", "a:stale-tool",
                lease_id=lease, tool="repo_list", input={}))
        self.interrupt_worker(replacement_lease, operation="exit-again")
        with self.assertRaises(RuntimeInvalidState):
            self.service.restore_worker(_write_request("runtime_restore_worker", "a", "a:restore-again",
                lease_id=replacement_lease, snapshot_id=snapshot.response["snapshot_id"]))
        self.assertEqual(self.service._attempts["a"].worker_recoveries, 1)

    def test_worker_restore_rejects_foreign_or_missing_checkpoint_without_consuming_recovery(self):
        other = self.worker("b")
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "b", "b:checkpoint", lease_id=other))
        lease = self.worker()
        self.interrupt_worker(lease)
        for index, snapshot_id in enumerate((snapshot.response["snapshot_id"], "snapshot-" + "0" * 64)):
            with self.assertRaises(RuntimeRequestRejected):
                self.service.restore_worker(_write_request("runtime_restore_worker", "a", f"a:restore-{index}",
                    lease_id=lease, snapshot_id=snapshot_id))
        self.assertEqual(self.service._attempts["a"].worker_recoveries, 0)

    def test_worker_restore_cleanup_failure_keeps_charge_and_stops_replacement(self):
        lease = self.worker()
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "a", "a:checkpoint", lease_id=lease))
        self.interrupt_worker(lease)
        self.client.volumes.fail_remove = True
        with self.assertRaises(RuntimeServiceUnavailable) as caught:
            self.service.restore_worker(_write_request("runtime_restore_worker", "a", "a:restore",
                lease_id=lease, snapshot_id=snapshot.response["snapshot_id"]))
        self.assertEqual(caught.exception.reason_code, "runtime_cleanup_blocked")
        self.assertEqual(self.service._attempts["a"].worker_recoveries, 1)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 1)

    def test_worker_exit_during_exec_is_classified_without_retrying_tool(self):
        lease = self.worker()
        original = self.backend._exec_json

        def exit_during_exec(container, command, **options):
            if "tool" in command:
                container.attrs["State"] = {"Status": "exited", "ExitCode": 137}
                raise RuntimeError("exec interrupted")
            return original(container, command, **options)

        with patch.object(self.backend, "_exec_json", side_effect=exit_during_exec) as execute:
            with self.assertRaises(RuntimeServiceUnavailable) as caught:
                self.service.execute_tool(_write_request("runtime_execute_tool", "a", "a:tool",
                    lease_id=lease, tool="repo_list", input={}))
        self.assertEqual(caught.exception.reason_code, "runtime_worker_exited")
        self.assertEqual(execute.call_count, 1)


if __name__ == "__main__":
    unittest.main()
