"""Test complete volume restoration, durable returns and lease generations."""

from dataclasses import replace
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from repofixlab_controller.runtime_docker import DockerRuntimeBackend, RuntimeDockerError
from repofixlab_controller.runtime_journal import RuntimeOperationJournal
from repofixlab_controller.runtime_reset import main as verify_roots, restore_tree, tree_identity
from repofixlab_controller.runtime_service import RuntimeInvalidState, RuntimeOperationService
from test_runtime_docker import _backend_fixture, _write_request


class ResetFilesystemTests(unittest.TestCase):
    def test_restore_keeps_verified_dependencies_and_breaks_task_hardlinks(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "image", root / "volume"
            source.mkdir()
            destination.mkdir()
            (source / "dependency").write_text("trusted dependency")
            (source / "code").write_text("original code")
            restore_tree(source, destination)
            with (destination / "dependency").open("rb") as original:
                (destination / "code").write_text("task edits")
                restore_tree(source, destination)
                self.assertEqual(os.fstat(original.fileno()).st_ino, (destination / "dependency").stat().st_ino)
            (destination / "code").unlink()
            os.link(destination / "dependency", destination / "code")
            restore_tree(source, destination)
            self.assertEqual(tree_identity(source), tree_identity(destination))
            self.assertEqual((destination / "dependency").stat().st_nlink, 1)
            self.assertNotEqual((destination / "dependency").stat().st_ino, (destination / "code").stat().st_ino)

    def test_restore_repairs_type_changes_unreadable_directories_and_extended_attributes(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination, outside = root / "image", root / "volume", root / "outside"
            source.mkdir()
            destination.mkdir()
            outside.mkdir()
            (outside / "safe").write_text("keep")
            (source / "directory").mkdir()
            (source / "directory/file").write_text("trusted")
            (source / "file").write_text("original")
            os.setxattr(source / "file", "user.baseline", b"trusted")
            restore_tree(source, destination)
            shutil.rmtree(destination / "directory")
            (destination / "directory").symlink_to(outside, target_is_directory=True)
            (destination / "file").unlink()
            (destination / "file").mkdir()
            (destination / "file/poison").write_text("old task")
            (destination / "file").chmod(0)
            os.setxattr(destination, "user.task", b"poison")
            restore_tree(source, destination)
            self.assertEqual(tree_identity(source), tree_identity(destination))
            self.assertEqual((outside / "safe").read_text(), "keep")
            os.setxattr(destination / "file", "user.baseline", b"poison")
            os.setxattr(destination / "file", "user.task", b"extra")
            restore_tree(source, destination)
            self.assertEqual(tree_identity(source), tree_identity(destination))

    def test_cached_baseline_still_checks_every_byte_metadata_link_and_extra_entry(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "image", root / "volume"
            source.mkdir()
            destination.mkdir()
            (source / "dependency").write_text("trusted")
            (source / "link").symlink_to("dependency")
            expected = restore_tree(source, destination)["baseline"]
            descriptors = [{"root": str(destination), "destination": str(destination),
                "source": "/unmounted-image", "verify_only": True, "baseline": expected}]
            with patch("sys.argv", ["verify", json.dumps(descriptors)]), redirect_stdout(io.StringIO()):
                verify_roots()
            for corruption in ("bytes", "mode", "link", "extra"):
                with self.subTest(corruption=corruption):
                    restore_tree(source, destination)
                    if corruption == "bytes":
                        (destination / "dependency").write_text("poisoned")
                    elif corruption == "mode":
                        (destination / "dependency").chmod(0o400)
                    elif corruption == "link":
                        (destination / "link").unlink()
                        (destination / "link").symlink_to("/tmp/another-task")
                    else:
                        (destination / "untracked").write_text("another task")
                    before = tree_identity(destination)
                    with patch("sys.argv", ["verify", json.dumps(descriptors)]), self.assertRaises(ValueError):
                        verify_roots()
                    self.assertEqual(tree_identity(destination), before)

    def test_full_tree_restores_git_ignored_dependencies_modes_and_symlinks(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination, outside = root / "image", root / "volume", root / "outside"
            source.mkdir()
            destination.mkdir()
            outside.mkdir()
            (outside / "safe").write_text("keep")
            for path, content in {".git/config": "trusted", "src/code": "base", "node_modules/dep": "installed"}.items():
                target = source / path
                target.parent.mkdir(exist_ok=True)
                target.write_text(content)
            (source / "node_modules/link").symlink_to("dep")
            first = restore_tree(source, destination)
            (destination / ".git/config").write_text("polluted")
            (destination / "node_modules/dep").write_text("poisoned dependency")
            (destination / "src/code").chmod(0o400)
            (destination / "untracked").write_text("old task")
            (destination / "escape").symlink_to(outside, target_is_directory=True)
            os.mkfifo(destination / "residual-pipe")
            result = restore_tree(source, destination)
            self.assertEqual(result, first)
            self.assertEqual(tree_identity(source), tree_identity(destination))
            self.assertEqual((outside / "safe").read_text(), "keep")
            self.assertFalse((destination / "untracked").exists())
            self.assertFalse((destination / "residual-pipe").exists())

    def test_output_clear_removes_all_files_and_rejects_symlink_mount_root(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "old-output").write_text("another job")
            self.assertEqual(restore_tree(None, root), {"empty": True})
            self.assertFalse(list(root.iterdir()))
            (root / "redirect").symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "trusted directory"):
                restore_tree(None, root / "redirect")


class UsedContainerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        fixture, self.client, self.candidate = _backend_fixture(self.root)
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
        self.service.preflight(_write_request("runtime_preflight", attempt, f"{attempt}:preflight", **binding))
        self.backend.worker_pool.wait_prepared()
        response = self.service.prepare_worker(_write_request("runtime_prepare_worker", attempt, f"{attempt}:prepare", **binding)).response
        return response["lease_id"], self.service._attempts[attempt].worker

    def finish_worker(self, attempt, lease):
        snapshot = self.service.snapshot_patch(_write_request("runtime_snapshot_patch", attempt, f"{attempt}:snapshot", lease_id=lease)).response
        request = _write_request("runtime_destroy_worker", attempt, f"{attempt}:destroy", lease_id=lease)
        response = self.service.destroy_worker(request).response
        self.assertTrue(response["cleanup"]["clean"])
        self.assertTrue(self.service.destroy_worker(request).replayed)
        return snapshot, response

    def evaluation(self, attempt, snapshot):
        self.backend.evaluator_pool.wait_prepared()
        response = self.service.start_evaluation(_write_request("runtime_start_evaluation", attempt, f"{attempt}:evaluate",
            snapshot_id=snapshot["snapshot_id"], run_id=f"run-{attempt}")).response
        job = self.service._attempts[attempt].job
        artifacts = self.service.get_artifacts(response["job_id"])
        ack = self.service.acknowledge_artifacts(_write_request("runtime_ack_artifacts", attempt, f"{attempt}:ack",
            job_id=response["job_id"], artifact_set_sha256=artifacts["artifact_set_sha256"])).response
        self.assertTrue(ack["cleanup"]["clean"])
        return job, artifacts, ack

    def test_a_b_a_reuses_both_roles_and_rejects_old_handles_and_results(self):
        workers, jobs, leases = [], [], []
        for attempt in ("a-first", "b", "a-again"):
            lease, worker = self.worker(attempt)
            workers.append(worker)
            leases.append(lease)
            self.assertFalse(worker.volumes[0].files)
            worker.volumes[0].files.update({".git/config": b"dirty", "node_modules/dependency": b"poison",
                                          "untracked": b"old", ".cache/task": b"cache"})
            worker.container.files["/tmp/task"] = b"residue"
            snapshot, cleanup = self.finish_worker(attempt, lease)
            self.assertEqual(cleanup["release_evidence"]["disposition"], "parked")
            self.assertFalse(worker.container.removed)
            self.assertEqual(worker.container.attrs["State"]["Status"], "exited")
            job, artifacts, ack = self.evaluation(attempt, snapshot)
            jobs.append(job)
            self.assertEqual(ack["release_evidence"]["disposition"], "parked")
            self.assertFalse(job.container.removed)
            report = json.loads(job.artifacts["evaluation.json"])
            self.assertEqual(report["attempt_id"], attempt)
        self.assertEqual(len({worker.container.id for worker in workers}), 1)
        self.assertEqual(len({job.container.id for job in jobs}), 1)
        self.assertEqual([worker.generation for worker in workers], [1, 2, 3])
        self.assertEqual([job.generation for job in jobs], [1, 2, 3])
        self.assertEqual(len(set(leases)), 3)
        for worker in workers:
            with self.assertRaisesRegex(RuntimeDockerError, "generation"):
                self.backend.execute_tool(worker, "repo_list", {"path": "."})
        for job in jobs:
            with self.assertRaisesRegex(RuntimeDockerError, "generation"):
                self.backend.get_artifacts(job)
        with self.assertRaises(RuntimeInvalidState):
            self.service.execute_tool(_write_request("runtime_execute_tool", "a-first", "stale-new-operation",
                lease_id=leases[0], tool="repo_list", input={"path": "."}))
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_000_000_000)

    def test_failed_reset_is_destroyed_and_next_task_gets_fresh_container(self):
        lease, worker = self.worker("bad")
        with patch.object(self.backend, "_volume_reset", side_effect=RuntimeDockerError("injected reset failure")):
            snapshot, cleanup = self.finish_worker("bad", lease)
        self.assertEqual(cleanup["release_evidence"]["disposition"], "quarantined_destroyed")
        self.assertTrue(worker.container.removed)
        self.assertTrue(all(volume.removed for volume in worker.volumes))
        self.service.abort_attempt(_write_request("runtime_abort_attempt", "bad", "bad:abort"))
        _, fresh = self.worker("next")
        self.assertNotEqual(fresh.container.id, worker.container.id)
        self.assertEqual(fresh.generation, 1)

    def test_parked_contamination_rejects_claim_and_preserves_no_lease(self):
        lease, worker = self.worker("first")
        self.finish_worker("first", lease)
        self.service.abort_attempt(_write_request("runtime_abort_attempt", "first", "first:abort"))
        worker.volumes[0].files["node_modules/poison"] = b"changed while parked"
        with self.assertRaisesRegex(RuntimeError, "claim"):
            self.backend.prepare_worker("second", self.candidate.candidate_id, self.candidate.instance_id)
        self.assertTrue(worker.container.removed)
        self.assertFalse(self.backend._active_generations)

    def test_return_waits_for_durable_receipt_before_next_claim(self):
        _, worker = self.worker("first")
        cleanup = self.backend.destroy_worker(worker)
        self.assertEqual(self.backend.worker_pool.snapshot["validated"], 1)
        self.assertEqual(self.backend.worker_pool.snapshot["ready"], 0)
        self.backend.publish_release(cleanup.release_evidence)
        self.assertEqual(self.backend.worker_pool.snapshot["ready"], 1)
        self.backend.publish_release(cleanup.release_evidence)
        self.assertEqual(self.backend.worker_pool.snapshot["ready"], 1)

    def test_parked_command_drift_is_rejected_before_restart(self):
        lease, worker = self.worker("first")
        self.finish_worker("first", lease)
        self.service.abort_attempt(_write_request("runtime_abort_attempt", "first", "first:abort"))
        worker.container.attrs["Config"]["Cmd"] = ["-c", "untrusted command"]
        with self.assertRaisesRegex(RuntimeError, "claim"):
            self.backend.prepare_worker("second", self.candidate.candidate_id, self.candidate.instance_id)
        self.assertTrue(worker.container.removed)
        self.assertNotIn("container.start:worker", self.client.events)

    def test_role_environment_keys_and_incompatible_task_are_rejected(self):
        _, worker = self.worker("first")
        self.assertNotEqual(self.backend._worker_environment_key(self.candidate),
                            self.backend._evaluator_environment_key(self.candidate))
        with self.assertRaises(RuntimeDockerError):
            self.backend.prepare_worker("other", self.candidate.candidate_id, "other__task")
        self.assertFalse(worker.container.removed)

    def test_failed_resume_cleanup_preserves_logical_charge_and_recovery_owner(self):
        lease, worker = self.worker("first")
        self.finish_worker("first", lease)
        self.service.abort_attempt(_write_request("runtime_abort_attempt", "first", "first:abort"))
        self.client.volumes.fail_remove = True
        with patch.object(self.backend, "_volume_reset", side_effect=RuntimeDockerError("injected resume failure")):
            with self.assertRaisesRegex(RuntimeError, "claim"):
                self.backend.prepare_worker("second", self.candidate.candidate_id, self.candidate.instance_id)
        self.assertEqual(self.backend._worker_owners["second"], worker.resource_owner)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"],
                         1_000_000_000 + self.candidate.definition.worker.nano_cpus)
        self.client.volumes.fail_remove = False
        self.assertTrue(self.backend.recover_attempt("second").clean)
        self.assertFalse(self.backend._worker_owners)
        self.assertEqual(self.backend.resource_admission.snapshot["nano_cpus"], 1_000_000_000)


if __name__ == "__main__":
    unittest.main()
