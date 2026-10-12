"""Raw evidence must remain reproducible, failure-inclusive and tamper checked."""

import base64
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from repofixlab_controller.runtime_benchmark import archive_artifacts, load_manifest, run_sample, summarize
from repofixlab_controller.runtime_journal import canonical_runtime_bytes, runtime_request_sha256


class RuntimeBenchmarkTests(unittest.TestCase):
    def test_exited_evaluator_releases_compute_before_official_grading(self):
        manifest = {"repetitions": 1, "cohorts": [], "resources": {"controller_cpu": 1, "controller_memory_bytes": 100}}
        records = [
            {"record_type": "container", "id": "worker", "event": "create", "at_ns": 1,
             "host_config": {"NanoCpus": 4_000_000_000, "Memory": 800}},
            {"record_type": "container", "id": "evaluator", "event": "create", "at_ns": 2,
             "host_config": {"NanoCpus": 4_000_000_000, "Memory": 800}},
            {"record_type": "container", "id": "evaluator", "event": "exit", "at_ns": 3},
            {"record_type": "container", "id": "grader", "event": "create", "at_ns": 4,
             "host_config": {"NanoCpus": 2_000_000_000, "Memory": 400}}]
        self.assertEqual(summarize(records, manifest)["resources"]["peak_reserved_cpu"], 9)

    def test_stopped_reuse_helpers_and_restart_cpu_are_fully_counted(self):
        manifest = {"repetitions": 1, "cohorts": [], "resources": {"controller_cpu": 1, "controller_memory_bytes": 100}}
        role = {"NanoCpus": 4_000_000_000, "Memory": 800}
        records = [
            {"record_type": "container", "id": "role", "event": "create", "at_ns": 1, "host_config": role},
            {"record_type": "container", "id": "role", "event": "stop", "at_ns": 2},
            {"record_type": "container", "id": "reset", "event": "create", "at_ns": 3,
             "host_config": {"NanoCpus": 2_000_000_000, "Memory": 400}},
            {"record_type": "container", "id": "reset", "event": "remove", "at_ns": 4},
            {"record_type": "container", "id": "role", "event": "start", "at_ns": 5, "host_config": role},
            {"record_type": "resource", "at_ns": 1, "usage": [{"id": "role", "cpu_total_ns": 10_000_000_000, "memory_bytes": 0}], "started_container_count": 1},
            {"record_type": "resource", "at_ns": 2, "usage": [{"id": "role", "cpu_total_ns": 1_000_000_000, "memory_bytes": 0}], "started_container_count": 1},
            {"record_type": "resource", "at_ns": 3, "usage": [{"id": "role", "cpu_total_ns": 4_000_000_000, "memory_bytes": 0}], "started_container_count": 1},
            {"record_type": "worker_pool", "event": "reset_verified", "duration_ns": 2_000_000_000},
            {"record_type": "worker_pool", "event": "lease_started", "container_id": "role", "generation": 2},
            {"record_type": "batch", "wall_ns": 30_000_000_000}]
        report = summarize(records, manifest)
        self.assertEqual(report["resources"]["peak_reserved_cpu"], 5)
        self.assertEqual(report["resources"]["sampled_cpu_seconds"], 14)
        self.assertEqual(report["reset"]["worker"]["total_seconds"], 2)
        self.assertEqual(report["reset"]["worker"]["reused_containers"], 1)

    def test_evaluator_overlap_clips_other_workers_and_counts_once(self):
        manifest = {"repetitions": 1, "cohorts": [], "resources": {"controller_cpu": 1, "controller_memory_bytes": 100}}
        records = [{"record_type": "evaluator_pool", "event": "prepared", "duration_ns": 10_000_000_000},
                   {"record_type": "evaluator_pool", "event": "hit"},
                   {"record_type": "span", "phase": "evaluator.prewarm", "attempt_id": "a", "started_ns": 0, "ended_ns": 10_000_000_000},
                   {"record_type": "span", "phase": "worker.verification", "attempt_id": "a", "started_ns": 0, "ended_ns": 10_000_000_000},
                   {"record_type": "span", "phase": "worker.verification", "attempt_id": "b", "started_ns": 2_000_000_000, "ended_ns": 7_000_000_000},
                   {"record_type": "span", "phase": "worker.verification", "attempt_id": "c", "started_ns": 4_000_000_000, "ended_ns": 12_000_000_000},
                   {"record_type": "batch", "wall_ns": 20_000_000_000}]
        report = summarize(records, manifest)
        self.assertEqual(report["evaluator_pool"]["preparation_seconds"], 10)
        self.assertEqual(report["evaluator_pool"]["overlap_worker_verification_seconds"], 8)
        self.assertEqual(report["evaluator_pool"]["overlapping_preparations"], 1)
        self.assertEqual(report["batch_wall_seconds"], 20)

    def test_pool_report_counts_preparation_failures_and_inside_batch_warmup(self):
        manifest = {"repetitions": 1, "cohorts": [], "resources": {"controller_cpu": 1, "controller_memory_bytes": 100}}
        records = [{"record_type": "worker_pool", "event": "prepared", "duration_ns": 3_000_000_000},
                   {"record_type": "worker_pool", "event": "prepare_failed", "duration_ns": 2_000_000_000},
                   {"record_type": "worker_pool", "event": "hit"}, {"record_type": "worker_pool", "event": "miss"},
                   {"record_type": "span", "phase": "worker.queue_warmup", "started_ns": 0, "ended_ns": 4_000_000_000},
                   {"record_type": "batch", "wall_ns": 10_000_000_000}]
        report = summarize(records, manifest)
        self.assertEqual(report["worker_pool"]["preparation_seconds"], 5)
        self.assertEqual(report["worker_pool"]["warmup_wall_seconds"], 4)
        self.assertEqual(report["worker_pool"]["hit_rate"], 0.5)
        self.assertEqual(report["batch_wall_seconds"], 10)

    def test_replay_operation_ids_are_unique_across_attempts_and_failures_are_retained(self):
        requests = []
        task = {"instance_id": "task", "candidate_id": "candidate", "candidate_sha256": "a" * 64,
                "base_commit": "b" * 40, "task_environment_lock_id": "lock", "task_environment_lock_sha256": "c" * 64,
                "expected_resolved": False}

        class Result:
            def __init__(self, response):
                self.response = response

        class Service:
            def preflight(self, request):
                requests.append(request)
                return Result({"manifest": task})

            def prepare_worker(self, request):
                requests.append(request)
                raise RuntimeError("injected preparation failure")

            def abort_attempt(self, request):
                requests.append(request)
                return Result({"cleanup": {"clean": True}})

        with TemporaryDirectory() as root:
            for attempt in ("first", "second"):
                sample = {"sample_id": attempt, "attempt_id": attempt}
                result = run_sample(Service(), task, Path(root), Path(root) / attempt, sample)
                self.assertEqual(result["status"], "failed")
                self.assertTrue(result["cleanup_clean"])
                self.assertEqual(json.loads((Path(root) / attempt / "sample.json").read_bytes()), result)
        self.assertEqual(len({request["operation_id"] for request in requests}), len(requests))
        for request in requests:
            self.assertEqual(request["request_sha256"], runtime_request_sha256({key: value for key, value in request.items() if key != "request_sha256"}))

    def test_manifest_drift_is_rejected_before_runtime_launch(self):
        with TemporaryDirectory() as root:
            source = Path(root)
            (source / "patch").write_bytes(b"fixed")
            manifest = {"schema_version": "v1", "mode": "sequential_on_demand", "files": [{"path": "patch", "sha256": hashlib.sha256(b"fixed").hexdigest()}]}
            path = source / "manifest.json"
            path.write_text(json.dumps(manifest))
            self.assertEqual(load_manifest(path, source), manifest)
            (source / "patch").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "drifted"):
                load_manifest(path, source)
            manifest["files"][0]["path"] = "../escape"
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "escapes"):
                load_manifest(path, source)

    def test_report_keeps_failures_and_overlaps_and_transient_reservations(self):
        manifest = {"repetitions": 1, "cohorts": [{"id": "same", "instance_ids": ["task", "task"]}], "resources": {"controller_cpu": 1, "controller_memory_bytes": 100}}
        records = [
            {"record_type": "sample", "sample_id": "ok", "cohort": "same", "status": "completed", "consistent": True, "cleanup_clean": True, "started_ns": 0, "ended_ns": 10_000_000_000, "wall_ns": 10_000_000_000},
            {"record_type": "sample", "sample_id": "failed", "cohort": "same", "status": "failed", "cleanup_clean": False, "started_ns": 5_000_000_000, "ended_ns": 25_000_000_000, "wall_ns": 20_000_000_000},
            {"record_type": "span", "sample_id": "ok", "phase": "prepare", "started_ns": 0, "ended_ns": 4_000_000_000},
            {"record_type": "span", "sample_id": "ok", "phase": "prepare", "started_ns": 1_000_000_000, "ended_ns": 3_000_000_000},
            {"record_type": "container", "id": "helper", "event": "create", "at_ns": 1, "host_config": {"NanoCpus": 2_000_000_000, "Memory": 200}},
            {"record_type": "container", "id": "helper", "event": "remove", "at_ns": 2},
            {"record_type": "batch", "wall_ns": 40_000_000_000},
        ]
        report = summarize(records, manifest)
        self.assertEqual(report["samples"], 2)
        self.assertEqual(report["failures"], 1)
        self.assertEqual(report["batch_status"], "failed")
        self.assertFalse(report["cleanup_clean"])
        self.assertEqual(report["cohorts"]["same"]["throughput_per_minute"], 2.4)
        self.assertEqual(report["batch_throughput_per_minute"], 1.5)
        self.assertEqual(report["cohorts"]["same"]["phases"]["prepare"]["p95_seconds"], 4)
        self.assertEqual(report["cohorts"]["same"]["phases"]["prepare"]["observed_samples"], 1)
        self.assertEqual(report["cohorts"]["same"]["phases"]["prepare"]["not_started_samples"], 1)
        self.assertEqual(report["resources"]["peak_reserved_cpu"], 3)
        self.assertEqual(report["resources"]["peak_reserved_memory_bytes"], 300)
        self.assertEqual(report, summarize(records, manifest))
        startup_failure = summarize([{"record_type": "batch", "wall_ns": 1, "status": "failed", "error_class": "ValueError"}], manifest)
        self.assertEqual(startup_failure["batch_status"], "failed")
        self.assertEqual(startup_failure["batch_error_class"], "ValueError")
        self.assertEqual(startup_failure["not_executed_samples"], 2)

    def test_corrupt_artifact_cannot_be_acknowledged_as_archived(self):
        content = b"evidence"
        identity = [{"name": "evaluation.json", "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content)}]
        response = {"artifact_set_sha256": hashlib.sha256(canonical_runtime_bytes(identity)).hexdigest(),
                    "artifacts": [identity[0] | {"content_base64": base64.b64encode(content).decode()}]}
        with TemporaryDirectory() as root:
            archive_artifacts(response, Path(root) / "valid")
            self.assertEqual((Path(root) / "valid/evaluation.json").read_bytes(), content)
            response["artifacts"][0]["content_base64"] = base64.b64encode(b"wrong").decode()
            with self.assertRaisesRegex(ValueError, "content drifted"):
                archive_artifacts(response, Path(root) / "corrupt")


if __name__ == "__main__":
    unittest.main()
