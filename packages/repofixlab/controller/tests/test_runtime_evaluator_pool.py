"""Verify standby isolation, stage expansion and audited Evaluator retirement."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import replace
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from repofixlab_controller.runtime_admission import RuntimeAdmission, RuntimeAdmissionCancelled, RuntimeAdmissionTimeout
from repofixlab_controller.runtime_docker import DockerRuntimeBackend, RuntimeDockerError, _inject_material
from repofixlab_controller.runtime_journal import RuntimeOperationJournal
from repofixlab_controller.runtime_service import RuntimeInvalidState, RuntimeOperationService, RuntimeServiceUnavailable
from test_runtime_docker import _backend_fixture, _write_request
from test_runtime_worker_pool import wait_for


class EvaluatorPoolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        fixture, self.client, self.candidate = _backend_fixture(self.root)
        self.backend = DockerRuntimeBackend(
            self.client, fixture._catalog, replace(fixture._configuration, evaluator_pool_capacity=1,
                                                 total_nano_cpus=3_500_000_000,
                                                 total_memory_bytes=4 * 1024**3 + 768 * 1024**2),
            read_only_check=lambda _path: True,
        )
        self.service = RuntimeOperationService(self.backend, RuntimeOperationJournal(self.root / "journal"), capacity=2)
        self.pool = self.backend.evaluator_pool

    def tearDown(self):
        self.client.volumes.fail_remove = False
        self.service.close()
        self.temporary.cleanup()

    def prepare(self, attempt):
        binding = {"candidate_id": self.candidate.candidate_id, "instance_id": self.candidate.instance_id}
        self.service.preflight(_write_request("runtime_preflight", attempt, f"{attempt}:preflight", **binding))
        worker = self.service.prepare_worker(_write_request("runtime_prepare_worker", attempt, f"{attempt}:prepare", **binding)).response
        return worker["lease_id"]

    def destroy(self, attempt, lease):
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", attempt, f"{attempt}:snapshot", lease_id=lease)).response
        result = self.service.destroy_worker(_write_request("runtime_destroy_worker", attempt, f"{attempt}:destroy", lease_id=lease))
        self.assertTrue(result.response["cleanup"]["clean"])
        return snapshot

    def start(self, attempt, snapshot):
        return self.service.start_evaluation(_write_request(
            "runtime_start_evaluation", attempt, f"{attempt}:evaluate", run_id=f"run-{attempt}", snapshot_id=snapshot["snapshot_id"],
        ))

    def abort(self, attempt):
        return self.service.abort_attempt(_write_request("runtime_abort_attempt", attempt, f"{attempt}:abort"))

    def ready(self, attempt="a"):
        snapshot = self.destroy(attempt, self.prepare(attempt))
        self.pool.wait_prepared()
        self.assertEqual(self.pool.snapshot["ready"], 1)
        return snapshot, next(item for item in reversed(self.client.containers.created) if item.kind == "evaluator")

    def test_standby_is_empty_and_activation_binds_patch_and_all_job_identities(self):
        snapshot, physical = self.ready()
        self.assertEqual(physical.attrs["State"]["Status"], "exited")
        self.assertFalse(physical.artifacts)
        self.assertFalse(physical.mounts["/run/repofixlab/input"][0].files)
        self.assertEqual(physical.mounts["/run/repofixlab/input"][1], "ro")
        self.assertEqual(physical.mounts["/run/repofixlab/private"][1], "ro")
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_000_000_000)
        response = self.start("a", snapshot).response
        activation = json.loads(physical.files["/tmp/repofixlab-runtime/.activation"])
        arguments = activation["arguments"]
        for option, value in {"--attempt-id": "a", "--run-id": "run-a", "--job-id": response["job_id"],
                              "--evaluation-id": response["evaluation_id"], "--candidate-patch-sha256": snapshot["patch_sha256"]}.items():
            self.assertEqual(arguments[arguments.index(option) + 1], value)
        self.assertTrue(self.start("a", snapshot).replayed)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_500_000_000)
        self.assertEqual(sum(event["event"] == "hit" for event in self.pool.records), 1)
        artifacts = self.service.get_artifacts(response["job_id"])
        ack = self.service.acknowledge_artifacts(_write_request(
            "runtime_ack_artifacts", "a", "a:ack", job_id=response["job_id"], artifact_set_sha256=artifacts["artifact_set_sha256"],
        ))
        self.assertTrue(ack.response["cleanup"]["clean"])
        self.assertTrue(physical.removed)
        self.assertFalse(self.backend._evaluator_owners)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertFalse(self.client.volumes.private.removed)

    def test_preparation_overlaps_other_worker_and_expansion_keeps_old_charge(self):
        self.backend.resource_admission = RuntimeAdmission(3_000_000_000, 5 * 1024**3,
            baseline_nano_cpus=1_000_000_000, baseline_memory_bytes=512 * 1024**2)
        first, second = self.prepare("a"), self.prepare("b")
        snapshot = self.destroy("a", first)
        self.pool.wait_prepared()
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_500_000_000)
        with ThreadPoolExecutor(1) as executor:
            started = executor.submit(self.start, "a", snapshot)
            wait_for(lambda: self.backend.resource_admission.snapshot["waiting"] == 1)
            self.assertFalse(started.done())
            self.assertEqual(self.backend.resource_admission.snapshot["active"], 2)
            self.assertEqual(self.backend.resource_admission.snapshot["memory_bytes"], 768 * 1024**2)
            self.destroy("b", second)
            self.assertEqual(started.result(timeout=3).response["status"], "started")
        self.assertTrue(self.abort("a").response["cleanup"]["clean"])
        self.assertTrue(self.abort("b").response["cleanup"]["clean"])

    def test_abort_interrupts_expansion_and_preserves_the_other_worker(self):
        self.backend.resource_admission = RuntimeAdmission(3_000_000_000, 5 * 1024**3,
            baseline_nano_cpus=1_000_000_000, baseline_memory_bytes=512 * 1024**2)
        first, second = self.prepare("a"), self.prepare("b")
        snapshot = self.destroy("a", first)
        self.pool.wait_prepared()
        other = self.service._attempts["b"].worker.container
        with ThreadPoolExecutor(2) as executor:
            started = executor.submit(self.start, "a", snapshot)
            wait_for(lambda: self.backend.resource_admission.snapshot["waiting"] == 1)
            aborted = executor.submit(self.abort, "a")
            with self.assertRaisesRegex(RuntimeInvalidState, "runtime_queue_cancelled"):
                started.result(timeout=3)
            self.assertTrue(aborted.result(timeout=3).response["cleanup"]["clean"])
        self.assertFalse(other.removed)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 1)
        self.assertTrue(self.abort("b").response["cleanup"]["clean"])

    def test_stage_helpers_finish_before_evaluator_runs_alongside_other_worker(self):
        first, second = self.prepare("a"), self.prepare("b")
        snapshot = self.destroy("a", first)
        self.pool.wait_prepared()
        other = self.service._attempts["b"].worker.container
        self.assertEqual(self.start("a", snapshot).response["status"], "started")
        self.assertFalse(other.removed)
        self.assertEqual(self.backend.resource_admission.snapshot["waiting"], 0)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 2_000_000_000)
        events = self.client.events
        self.assertLess(events.index("container.remove:seed"), events.index("container.start:evaluator"))
        self.assertTrue(self.abort("a").response["cleanup"]["clean"])
        self.assertTrue(self.abort("b").response["cleanup"]["clean"])

    def test_dirty_kernel_input_evidence_command_or_private_task_rejects_claim(self):
        for field in ("Image", "kernel", "input", "evidence", "command", "private", "activation"):
            with self.subTest(field=field):
                attempt = f"drift-{field}"
                snapshot, physical = self.ready(attempt)
                if field == "Image":
                    physical.attrs["Image"] = "sha256:" + "0" * 64
                elif field in {"kernel", "activation"}:
                    def corrupt_kernel(container, files, **kwargs):
                        _inject_material(container, files, **kwargs)
                        path = ("/tmp/repofixlab-runtime/repofixlab_evaluator/__init__.py" if field == "kernel"
                                else "/tmp/repofixlab-runtime/.activation.pending")
                        container.files[path] = b"changed"
                elif field in {"input", "evidence"}:
                    physical.mounts[f"/run/repofixlab/{field}"][0].files["residue"] = b"changed"
                elif field == "command":
                    physical.attrs["Config"]["Cmd"] = ["-c", "changed"]
                elif field == "private":
                    binding = self.backend._private_task_bindings[self.candidate.candidate_id]
                    self.client.volumes.private.identities[binding.task_path] = "7:" + hashlib.sha256(b"changed").hexdigest()
                with ExitStack() as stack:
                    if field in {"kernel", "activation"}:
                        stack.enter_context(patch("repofixlab_controller.runtime_docker._inject_material", corrupt_kernel))
                    with self.assertRaises(RuntimeServiceUnavailable):
                        self.start(attempt, snapshot)
                self.assertTrue(physical.removed)
                self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
                self.abort(attempt)
                if field == "private":
                    self.client.volumes.private.identities[binding.task_path] = f"{binding.task_bytes}:{binding.task_sha256}"

    def test_snapshot_gate_prevents_early_evaluation_and_warming(self):
        lease = self.prepare("a")
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease)).response
        with self.assertRaises(RuntimeInvalidState):
            self.start("a", snapshot)
        self.assertEqual(sum(self.pool.snapshot.values()), 0)
        self.assertTrue(self.abort("a").response["cleanup"]["clean"])

    def test_known_queue_parks_verified_environment_before_worker_and_keeps_activation_gate(self):
        self.service.close()
        self.backend = DockerRuntimeBackend(
            self.client, self.backend._catalog, replace(self.backend._configuration, worker_pool_capacity=2),
            read_only_check=lambda _path: True,
        )
        self.service = RuntimeOperationService(self.backend, RuntimeOperationJournal(self.root / "journal"), capacity=2)
        self.pool = self.backend.evaluator_pool
        binding = {"candidate_id": self.candidate.candidate_id, "instance_id": self.candidate.instance_id}
        ready = self.backend._check_evaluator_ready

        def refreshed_index(evaluator, **kwargs):
            ready(evaluator, **kwargs)
            evaluator.volumes[0].files[".git/index"] = b"updated by initial git status"

        with patch.object(self.backend, "_check_evaluator_ready", refreshed_index):
            for attempt in ("a", "b"):
                self.service.preflight(_write_request("runtime_preflight", attempt, f"{attempt}:preflight", **binding))
            self.backend.worker_pool.wait_prepared()
            self.pool.wait_prepared()
        entry = next(iter(self.pool._entries.values()))
        self.assertTrue(entry.worker.parked)
        self.assertTrue(entry.worker.reset_evidence["verified"])
        self.assertEqual(entry.worker.generation, 0)
        self.assertEqual(entry.worker.container.attrs["State"]["Status"], "exited")
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_500_000_000)
        lease = self.prepare("a")
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", "a", "a:snapshot", lease_id=lease)).response
        with self.assertRaises(RuntimeInvalidState):
            self.start("a", snapshot)
        self.assertFalse(entry.worker.input_volume.files)
        self.assertFalse(entry.worker.container.files)
        self.assertTrue(self.abort("a").response["cleanup"]["clean"])
        self.assertEqual(self.pool.snapshot["ready"], 1)
        self.assertTrue(self.abort("b").response["cleanup"]["clean"])
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_failed_preparation_cleans_then_cold_fallback_completes(self):
        lease = self.prepare("a")
        with patch.object(self.backend, "_check_evaluator_ready", side_effect=RuntimeDockerError("injected")):
            snapshot = self.destroy("a", lease)
            wait_for(lambda: any(event["event"] == "retired" for event in self.pool.records))
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertEqual(self.start("a", snapshot).response["status"], "started")
        self.assertEqual(sum(event["event"] == "fallback" for event in self.pool.records), 1)
        self.assertTrue(self.abort("a").response["cleanup"]["clean"])

    def test_activation_failure_cleans_physical_owner_and_logical_charge(self):
        snapshot, physical = self.ready()
        with patch("repofixlab_controller.runtime_docker._publish_ready_marker", side_effect=RuntimeDockerError("activation failed")):
            with self.assertRaises(RuntimeServiceUnavailable):
                self.start("a", snapshot)
        self.assertTrue(physical.removed)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.assertFalse(self.backend._evaluator_owners)

    def test_expiry_and_failed_cleanup_hold_capacity_until_retry(self):
        self.ready()
        self.client.volumes.fail_remove = True
        with self.assertRaisesRegex(RuntimeError, "residual"):
            self.pool.evict_idle("test_cleanup")
        self.assertEqual(self.pool.snapshot["blocked"], 1)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 1)
        self.client.volumes.fail_remove = False
        for volume in self.client.volumes.created:
            if volume.labels.get("io.repofixlab.runtime.attempt-id") in self.backend._quarantined_owners:
                volume.remove(force=True)
        self.pool.evict_idle("retry")
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)
        self.abort("a")
        self.pool._idle_seconds = 0.02
        self.ready("b")
        wait_for(lambda: sum(self.pool.snapshot.values()) == 0)
        self.assertEqual(self.backend.resource_admission.snapshot["active"], 0)

    def test_restart_with_pool_disabled_cleans_own_namespace_only(self):
        _snapshot, physical = self.ready()
        foreign = self.client.volumes.create(name="foreign-evaluator", labels={
            "io.repofixlab.runtime.managed": "true", "io.repofixlab.runtime.evaluator-pool": "other",
            "io.repofixlab.runtime.attempt-id": "foreign-owner",
        })
        self.pool._stop.set()
        self.pool._sweeper.join()
        self.pool._executor.shutdown(wait=True)
        self.service._journal.close()
        replacement = DockerRuntimeBackend(
            self.client, self.backend._catalog, replace(self.backend._configuration, evaluator_pool_capacity=0),
            read_only_check=lambda _path: True,
        )
        self.service = RuntimeOperationService(replacement, RuntimeOperationJournal(self.root / "journal"), capacity=2)
        self.assertTrue(physical.removed)
        self.assertFalse(foreign.removed)
        self.assertIsNone(replacement.evaluator_pool)


class StageExpansionTests(unittest.TestCase):
    def test_retained_stage_passes_cold_waiter_that_depends_on_its_release(self):
        admission = RuntimeAdmission(9, 18)
        admission.acquire("warm", 4, 8)
        admission.acquire("worker", 4, 8)
        with ThreadPoolExecutor(2) as executor:
            cold = executor.submit(admission.acquire, "cold", 6, 12)
            wait_for(lambda: admission.snapshot["waiting"] == 1)
            expanded = executor.submit(admission.transfer, "warm", "evaluation", nano_cpus=6, memory_bytes=12)
            wait_for(lambda: admission.snapshot["waiting"] == 2)
            self.assertEqual(admission.snapshot["nano_cpus"], 8)
            admission.release("worker")
            expanded.result(timeout=3)
            self.assertFalse(cold.done())
            self.assertEqual(admission.snapshot["nano_cpus"], 6)
            admission.release("evaluation")
            cold.result(timeout=3)
        admission.release("cold")

    def test_timeout_and_cancellation_preserve_standby_reservation(self):
        for cancel in (False, True):
            admission = RuntimeAdmission(9, 18, timeout_seconds=0.05)
            admission.acquire("warm", 4, 8)
            admission.acquire("worker", 4, 8)
            with ThreadPoolExecutor(1) as executor:
                expanded = executor.submit(admission.transfer, "warm", "evaluation", nano_cpus=6, memory_bytes=12)
                wait_for(lambda: admission.snapshot["waiting"] == 1)
                if cancel:
                    admission.cancel("evaluation")
                with self.assertRaises(RuntimeAdmissionCancelled if cancel else RuntimeAdmissionTimeout):
                    expanded.result(timeout=3)
            self.assertEqual(admission.snapshot, {"active": 2, "waiting": 0, "nano_cpus": 8, "memory_bytes": 16})


if __name__ == "__main__":
    unittest.main()
