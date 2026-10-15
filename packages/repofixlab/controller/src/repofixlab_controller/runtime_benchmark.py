"""Replay frozen edits through the production runtime and retain every sample.

Run in the trusted controller image with read-only source and a Docker socket.
Only benchmark-owned SDK calls are observed. Runtime requests, task policies,
artifact acknowledgement and official grading use their production contracts.
"""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import statistics
from threading import Event, Lock, Thread
from time import monotonic_ns, sleep
from uuid import uuid4

import docker

from .factory_service import TrustedCandidateCatalog
from .runtime_docker import DockerRuntimeBackend, RuntimeDockerConfiguration
from .runtime_journal import RuntimeOperationJournal, canonical_runtime_bytes, runtime_request_sha256
from .runtime_service import RuntimeOperationService
from .runtime_timing import RuntimeTimings, interval_union_ns, runtime_phase


def write_json(path: Path, value: object) -> None:
    """Persist evidence before allowing artifact acknowledgement."""
    with path.open("wb") as stream:
        stream.write(canonical_runtime_bytes(value))
        stream.flush()
        os.fsync(stream.fileno())


def load_manifest(path: Path, source: Path) -> dict:
    manifest = json.loads(path.read_bytes())
    if manifest["schema_version"] != "v1" or manifest["mode"] != "sequential_on_demand":
        raise ValueError("unsupported benchmark manifest")
    for item in manifest["files"]:
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("manifest file escapes source")
        if hashlib.sha256((source / relative).read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError(f"frozen input drifted: {relative}")
    return manifest


class DockerResources:
    """Track transient helpers as well as Workers, Evaluators and the driver.

    Creation reserves a stage's limits. Explicit verified stops suspend compute;
    starts restore it, and all reset helpers count. Actual usage is sampled;
    short peaks between polls may be missed. Unstarted initializers retain their
    configured limits until removal and never count as running work.
    """

    def __init__(self, client: docker.DockerClient, driver_id: str) -> None:
        self.client = docker.from_env()
        self._lock = Lock()
        self._stop = Event()
        self.active: dict[str, dict] = {}
        self.records: list[dict] = []
        driver = self.client.api.inspect_container(driver_id)
        self.active[driver["Id"]] = {"id": driver["Id"], "name": driver["Name"], "started": True,
                                    "host_config": driver["HostConfig"], "role": "controller"}
        create = client.api.create_container
        start = client.api.start
        remove = client.api.remove_container
        stop = client.api.stop
        inspect = client.api.inspect_container

        def observed_inspect(container: str, *args: object, **kwargs: object) -> dict:
            result = inspect(container, *args, **kwargs)
            if result["State"]["Status"] in {"exited", "dead"}:
                with self._lock:
                    item = self.active.get(result["Id"])
                    if item is not None and item["started"]:
                        item.update(started=False, stopped=True)
                        self.records.append({"record_type": "container", "event": "exit",
                                             "at_ns": monotonic_ns(), **item})
            return result

        def observed_create(*args: object, **kwargs: object) -> dict:
            with runtime_phase("container.create"):
                result = create(*args, **kwargs)
            labels = kwargs.get("labels") or {}
            item = {"id": result["Id"], "name": kwargs.get("name"), "started": False,
                    "host_config": dict(kwargs.get("host_config") or {}),
                    "role": labels.get("io.repofixlab.runtime.role", "helper"),
                    "attempt_id": labels.get("io.repofixlab.runtime.attempt-id")}
            with self._lock:
                self.active[item["id"]] = item
                self.records.append({"record_type": "container", "event": "create", "at_ns": monotonic_ns(), **item})
            return result

        def observed_start(container: str, *args: object, **kwargs: object) -> object:
            with runtime_phase("container.start"):
                result = start(container, *args, **kwargs)
            with self._lock:
                self.active[container]["started"] = True
                self.active[container]["stopped"] = False
                self.records.append({"record_type": "container", "event": "start", "at_ns": monotonic_ns(), **self.active[container]})
            return result

        def observed_stop(container: str, *args: object, **kwargs: object) -> object:
            with runtime_phase("container.stop"):
                result = stop(container, *args, **kwargs)
            with self._lock:
                self.active[container].update(started=False, stopped=True)
                self.records.append({"record_type": "container", "event": "stop", "at_ns": monotonic_ns(), **self.active[container]})
            return result

        def observed_remove(container: str, *args: object, **kwargs: object) -> object:
            with runtime_phase("container.remove"):
                result = remove(container, *args, **kwargs)
            with self._lock:
                item = self.active.pop(container, None)
                self.records.append({"record_type": "container", "event": "remove", "at_ns": monotonic_ns(), "id": container,
                                     "attempt_id": item.get("attempt_id") if item else None})
            return result

        client.api.create_container = observed_create
        client.api.start = observed_start
        client.api.remove_container = observed_remove
        client.api.stop = observed_stop
        client.api.inspect_container = observed_inspect
        self._thread = Thread(target=self._sample, daemon=True)
        self._thread.start()

    def _sample(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                active = [dict(item) for item in self.active.values()]
            usage = []
            for item in active:
                if not item["started"]:
                    continue
                try:
                    stats = self.client.api.stats(item["id"], stream=False, one_shot=True)
                    usage.append({"id": item["id"], "role": item["role"],
                                  "cpu_total_ns": stats["cpu_stats"]["cpu_usage"]["total_usage"],
                                  "memory_bytes": stats.get("memory_stats", {}).get("usage", 0)})
                except docker.errors.APIError:
                    # Removal can race a poll; lifecycle evidence remains exact.
                    continue
            self.records.append({"record_type": "resource", "at_ns": monotonic_ns(), "usage": usage,
                                 "reserved_cpu": sum(item["host_config"].get("NanoCpus", 0) / 1e9 for item in active if not item.get("stopped")),
                                 "reserved_memory_bytes": sum(item["host_config"].get("Memory", 0) for item in active if not item.get("stopped")),
                                 "started_container_count": sum(item["started"] for item in active)})
            self._stop.wait(0.5)

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=30)
        if self._thread.is_alive():
            raise RuntimeError("resource sampler did not stop")
        self.client.close()


def archive_artifacts(response: dict, directory: Path) -> None:
    directory.mkdir()
    identity = []
    for artifact in response["artifacts"]:
        name = artifact["name"]
        if Path(name).name != name:
            raise ValueError("artifact name escapes archive")
        content = base64.b64decode(artifact["content_base64"], validate=True)
        if len(content) != artifact["size_bytes"] or hashlib.sha256(content).hexdigest() != artifact["sha256"]:
            raise ValueError("artifact content drifted")
        with (directory / name).open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        identity.append({key: artifact[key] for key in ("name", "sha256", "size_bytes")})
    if hashlib.sha256(canonical_runtime_bytes(identity)).hexdigest() != response["artifact_set_sha256"]:
        raise ValueError("artifact set drifted")
    write_json(directory / "artifact-index.json", {key: value for key, value in response.items() if key != "artifacts"} | {"artifacts": identity})


def run_sample(service: RuntimeOperationService, task: dict, source: Path, directory: Path, sample: dict) -> dict:
    """Use fixed repo edits, freeze their snapshot, verify, grade, archive, ACK."""
    directory.mkdir()
    operation = 0

    def request(method: object, request_type: str, **fields: object) -> dict:
        nonlocal operation
        operation += 1
        body = {"schema_version": "v1", "request_type": request_type, "attempt_id": sample["attempt_id"],
                "operation_id": f"{sample['sample_id']}:operation-{operation}", **fields}
        body["request_sha256"] = runtime_request_sha256(body)
        return method(body).response

    result = {**sample, "record_type": "sample", "instance_id": task["instance_id"], "expected_resolved": task["expected_resolved"],
              "started_ns": monotonic_ns(), "status": "failed", "error_class": None, "cleanup_clean": False}
    try:
        binding = {"candidate_id": task["candidate_id"], "instance_id": task["instance_id"]}
        preflight = request(service.preflight, "runtime_preflight", **binding)
        write_json(directory / "preflight.json", preflight)
        for key in ("candidate_sha256", "base_commit", "task_environment_lock_id", "task_environment_lock_sha256"):
            if preflight["manifest"][key] != task[key]:
                raise ValueError(f"frozen runtime binding drifted: {key}")
        worker = request(service.prepare_worker, "runtime_prepare_worker", **binding)
        write_json(directory / "worker-prepared.json", worker)
        lease = {"lease_id": worker["lease_id"]}
        result["worker_lease_id"] = worker["lease_id"]
        for edit in json.loads((source / task["edits_path"]).read_bytes()):
            response = request(service.execute_tool, "runtime_execute_tool", **lease, tool="repo_edit", input=edit)
            if response["result"]["exit_code"] != 0:
                raise RuntimeError("fixed edit failed")
        catalog = request(service.verification_catalog, "runtime_verification_catalog", **lease)["catalog"]
        write_json(directory / "verification-catalog.json", catalog)
        snapshot = request(service.snapshot_patch, "runtime_snapshot_patch", **lease)
        write_json(directory / "snapshot.json", snapshot)
        if snapshot["patch_sha256"] != task["patch_sha256"] or snapshot["base_commit"] != task["base_commit"]:
            raise ValueError("frozen snapshot drifted")
        entry = catalog["entries"][task["verification_entry_index"]]
        verification = request(service.verify_catalog_entry, "runtime_verify_catalog", **lease,
                               catalog_id=catalog["catalog_id"], candidate_id=entry["candidate_id"])
        write_json(directory / "verification.json", verification)
        cleanup = request(service.destroy_worker, "runtime_destroy_worker", **lease)
        write_json(directory / "worker-destroyed.json", cleanup)
        if not cleanup["cleanup"]["clean"]:
            raise RuntimeError("worker cleanup left residuals")
        job = request(service.start_evaluation, "runtime_start_evaluation", snapshot_id=snapshot["snapshot_id"], run_id=sample["sample_id"])
        write_json(directory / "evaluation-started.json", job)
        result["job_id"] = job["job_id"]
        deadline = monotonic_ns() + 360 * 1_000_000_000
        with runtime_phase("evaluator.verification", role="evaluator"):
            while True:
                status = service.get_job(job["job_id"])
                if status["status"] in {"completed", "failed"}:
                    break
                if monotonic_ns() > deadline:
                    raise TimeoutError("official evaluation deadline exceeded")
                sleep(0.1)
        with runtime_phase("artifact.archive", role="controller"):
            artifacts = service.get_artifacts(job["job_id"])
            archive_artifacts(artifacts, directory / "artifacts")
        ack = request(service.acknowledge_artifacts, "runtime_ack_artifacts", job_id=job["job_id"], artifact_set_sha256=artifacts["artifact_set_sha256"])
        write_json(directory / "artifacts-acknowledged.json", ack)
        result.update(status=status["status"], resolved=status["resolved"], error_class=status["error_class"],
                      cleanup_clean=ack["cleanup"]["clean"], artifact_set_sha256=artifacts["artifact_set_sha256"],
                      consistent=status["resolved"] == task["expected_resolved"])
        evaluation = json.loads((directory / "artifacts/evaluation.json").read_bytes())
        result["official_grading"] = evaluation["official_grading"]
    except Exception as error:
        result["error_class"] = type(error).__name__
        result["error_message"] = str(error)
        try:
            cleanup = request(service.abort_attempt, "runtime_abort_attempt")
            result["cleanup_clean"] = cleanup["cleanup"]["clean"]
        except Exception as cleanup_error:
            result["cleanup_error_class"] = type(cleanup_error).__name__
    result["ended_ns"] = monotonic_ns()
    result["wall_ns"] = result["ended_ns"] - result["started_ns"]
    with runtime_phase("sample.archive", role="controller"):
        write_json(directory / "sample.json", result)
    return result


def phase_statistics(spans: list[dict], samples: list[dict], role: str | None = None) -> dict:
    """Missing phases stay explicit; overlapping observations contribute once."""
    selected_ids = {item["sample_id"] for item in samples}
    selected = [item for item in spans if item.get("sample_id") in selected_ids and (role is None or item.get("role") == role)]
    statistics_by_phase = {}
    for phase in sorted({item["phase"] for item in selected}):
        values = []
        for sample in samples:
            intervals = [item for item in selected if item.get("sample_id") == sample["sample_id"] and item["phase"] == phase]
            if intervals:
                values.append(interval_union_ns(intervals) / 1e9)
        ordered = sorted(values)
        statistics_by_phase[phase] = {"p50_seconds": statistics.median(values),
                                      "p95_seconds": ordered[max(0, (len(values) * 95 + 99) // 100 - 1)],
                                      "observed_samples": len(values), "not_started_samples": len(samples) - len(values)}
    return statistics_by_phase


def summarize(records: list[dict], manifest: dict) -> dict:
    """Regenerate from raw evidence; failures remain in every denominator."""
    samples = [item for item in records if item["record_type"] == "sample"]
    spans = [item for item in records if item["record_type"] == "span"]
    resources = [item for item in records if item["record_type"] == "resource"]
    groups = {}
    for cohort in manifest["cohorts"]:
        selected = [item for item in samples if item["cohort"] == cohort["id"]]
        # Active cohort time counts overlapping attempts once. Batch wall also
        # includes bootstrap and inter-attempt archive/dispatch overhead.
        wall = interval_union_ns(selected) / 1e9
        completed = sum(item["status"] == "completed" for item in selected)
        groups[cohort["id"]] = {"samples": len(selected), "completed": completed,
                                "failures": len(selected) - completed, "consistent": sum(item.get("consistent", False) for item in selected),
                                "sample_wall_seconds": wall, "throughput_per_minute": completed * 60 / wall if wall else 0,
                                "phases": phase_statistics(spans, selected),
                                "roles": {role: phase_statistics(spans, selected, role) for role in ("worker", "evaluator", "controller")},
                                "conditions": {condition: phase_statistics(spans, [item for item in selected if item.get("condition") == condition]) for condition in ("first_pass", "repeated")}}
    batches = [item for item in records if item["record_type"] == "batch"]
    batch_wall = batches[-1]["wall_ns"] / 1e9 if batches else 0
    expected_samples = 1 if batches and batches[-1].get("pilot") else manifest.get("repetitions", 0) * sum(len(item.get("instance_ids", [])) for item in manifest["cohorts"])
    inferred_status = "completed" if len(samples) == expected_samples and all(item["status"] == "completed" and item.get("consistent", False) and item["cleanup_clean"] for item in samples) else "failed"
    cpu_totals = {}
    previous = {}
    peak_cpu = 0
    previous_at = None
    for item in sorted(resources, key=lambda value: value["at_ns"]):
        delta = 0
        for usage in item["usage"]:
            total = usage["cpu_total_ns"]
            old = previous.get(usage["id"], 0)
            cpu_totals[usage["id"]] = cpu_totals.get(usage["id"], 0) + (total - old if total >= old else total)
            if usage["id"] in previous:
                delta += max(0, total - previous[usage["id"]])
            previous[usage["id"]] = total
        if previous_at is not None and item["at_ns"] > previous_at:
            peak_cpu = max(peak_cpu, delta / (item["at_ns"] - previous_at))
        previous_at = item["at_ns"]
    active = {}
    peak_reserved_cpu = manifest["resources"]["controller_cpu"]
    peak_reserved_memory = manifest["resources"]["controller_memory_bytes"]
    for item in sorted((value for value in records if value["record_type"] == "container"), key=lambda value: value["at_ns"]):
        if item["event"] in {"create", "start"}:
            active[item["id"]] = item["host_config"]
        elif item["event"] in {"stop", "exit"}:
            active[item["id"]] = {}
        elif item["event"] == "remove":
            active.pop(item["id"], None)
        peak_reserved_cpu = max(peak_reserved_cpu, manifest["resources"]["controller_cpu"] + sum(value.get("NanoCpus", 0) / 1e9 for value in active.values()))
        peak_reserved_memory = max(peak_reserved_memory, manifest["resources"]["controller_memory_bytes"] + sum(value.get("Memory", 0) for value in active.values()))
    quality = {}
    pool_events = [item for item in records if item["record_type"] == "worker_pool"]
    evaluator_events = [item for item in records if item["record_type"] == "evaluator_pool"]
    # Clip preparation to another attempt's verification, counting simultaneous
    # intervals once. Waiting for stage expansion contributes no overlap here.
    overlap_intervals = []
    overlapping_preparations = 0
    for warm in (item for item in spans if item["phase"] == "evaluator.prewarm"):
        clipped = []
        for worker in (item for item in spans if item["phase"] == "worker.verification"
                       and item.get("attempt_id") != warm.get("attempt_id")):
            start = max(warm["started_ns"], worker["started_ns"])
            end = min(warm["ended_ns"], worker["ended_ns"])
            if end > start:
                clipped.append({"started_ns": start, "ended_ns": end})
        overlapping_preparations += bool(clipped)
        overlap_intervals.extend(clipped)
    for sample in samples:
        grading = sample.get("official_grading")
        if grading is None:
            continue
        signature = {key: grading[key] for key in ("resolved", "fail_to_pass", "pass_to_pass", "status_map_sha256")}
        task_quality = quality.setdefault(sample["instance_id"], {"signature": signature, "observed_samples": 0, "consistent_samples": 0})
        task_quality["observed_samples"] += 1
        task_quality["consistent_samples"] += signature == task_quality["signature"]
    return {"schema_version": "v1", "manifest_sha256": hashlib.sha256(canonical_runtime_bytes(manifest)).hexdigest(),
            **({"execution": batches[-1]["execution"]} if batches and "execution" in batches[-1] else {}),
            **({"worker_pool": {
                "events": {event: sum(item["event"] == event for item in pool_events)
                           for event in sorted({item["event"] for item in pool_events})},
                "hit_rate": sum(item["event"] == "hit" for item in pool_events) / max(1, sum(item["event"] in {"hit", "miss"} for item in pool_events)),
                "preparation_seconds": sum(item.get("duration_ns", 0) for item in pool_events
                                           if item["event"] in {"prepared", "prepare_failed"}) / 1e9,
                "warmup_wall_seconds": interval_union_ns([item for item in spans if item["phase"] == "worker.queue_warmup"]) / 1e9,
            }} if pool_events else {}),
            **({"evaluator_pool": {
                "events": {event: sum(item["event"] == event for item in evaluator_events)
                           for event in sorted({item["event"] for item in evaluator_events})},
                "hit_rate": sum(item["event"] == "hit" for item in evaluator_events) / max(1, sum(item["event"] in {"hit", "miss"} for item in evaluator_events)),
                "preparation_seconds": sum(item.get("duration_ns", 0) for item in evaluator_events
                                           if item["event"] in {"prepared", "prepare_failed"}) / 1e9,
                "overlapping_preparations": overlapping_preparations,
                "overlap_worker_verification_seconds": interval_union_ns(overlap_intervals) / 1e9,
            }} if evaluator_events else {}),
            "batch_status": batches[-1].get("status", inferred_status) if batches else "missing",
            "batch_error_class": batches[-1].get("error_class") if batches else None,
            "expected_samples": expected_samples, "not_executed_samples": max(0, expected_samples - len(samples)),
            "samples": len(samples), "failures": sum(item["status"] != "completed" for item in samples),
            "consistent": sum(item.get("consistent", False) for item in samples),
            "cleanup_clean": all(item["cleanup_clean"] for item in samples), "cohorts": groups,
            "quality": quality,
            "reset": {role: {"verified": sum(item["event"] == "reset_verified" for item in events),
                              "failed": sum(item["event"] == "reset_failed" for item in events),
                              "total_seconds": sum(item.get("duration_ns", 0) for item in events
                                                   if item["event"] in {"reset_verified", "reset_failed"}) / 1e9,
                              "reused_containers": len({item["container_id"] for item in events
                                                         if item["event"] == "lease_started" and item["generation"] > 1})}
                      for role, events in (("worker", pool_events), ("evaluator", evaluator_events))},
            "bootstrap_seconds": interval_union_ns([item for item in spans if item["phase"] == "runtime.bootstrap"]) / 1e9,
            "batch_wall_seconds": batch_wall,
            "batch_throughput_per_minute": sum(item["status"] == "completed" for item in samples) * 60 / batch_wall if batch_wall else 0,
            "resources": {"peak_reserved_cpu": peak_reserved_cpu,
                          "peak_reserved_memory_bytes": peak_reserved_memory,
                          "peak_sampled_cpu_cores": peak_cpu,
                          "sampled_cpu_seconds": sum(cpu_totals.values()) / 1e9,
                          "peak_sampled_memory_bytes": max((sum(usage["memory_bytes"] for usage in item["usage"]) for item in resources), default=0),
                          "peak_started_container_count": max((item["started_container_count"] for item in resources), default=0),
                          "poll_interval_seconds": 0.5}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("/source"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report-only", action="store_true")
    parser.add_argument("--pilot", action="store_true", help="Run one sample; keep a separate output directory.")
    parser.add_argument("--concurrency", type=int, choices=(1, 2), default=1,
                        help="Replay each frozen cohort with bounded parallel attempts.")
    parser.add_argument("--worker-pool", action="store_true", help="Prewarm the known cohort inside the batch timing boundary.")
    parser.add_argument("--evaluator-pool", action="store_true", help="Prepare a standby Evaluator after audited Worker cleanup.")
    parser.add_argument("--reuse", action="store_true", help="Reset both used roles and keep verified stopped containers in their pools.")
    args = parser.parse_args()
    if args.reuse and not (args.worker_pool and args.evaluator_pool):
        parser.error("--reuse requires --worker-pool and --evaluator-pool")
    if args.report_only:
        # Reporting consumes the saved manifest and raw evidence without Docker
        # or requiring historical source fixtures to remain installed.
        manifest = json.loads(args.manifest.read_bytes())
        saved = json.loads((args.output / "manifest.json").read_bytes())
        if canonical_runtime_bytes(manifest) != canonical_runtime_bytes(saved):
            raise ValueError("report manifest differs from recorded run")
        records = [json.loads(line) for line in (args.output / "raw.ndjson").read_text().splitlines()]
        write_json(args.output / "report.json", summarize(records, manifest))
        return
    manifest = load_manifest(args.manifest, args.source)
    args.output.mkdir(parents=True, exist_ok=True)
    if (args.output / "raw.ndjson").exists():
        raise ValueError("output already contains a run")
    write_json(args.output / "manifest.json", manifest)
    started = monotonic_ns()
    timings = RuntimeTimings()
    session = uuid4().hex[:12]
    client = docker.from_env()
    resources = DockerResources(client, os.environ["HOSTNAME"])
    records = []
    service = None
    backend = None
    batch_error_class = None
    runtime_sources = [{"path": f"controller/src/repofixlab_controller/{name}.py",
                       "sha256": hashlib.sha256((args.source / f"controller/src/repofixlab_controller/{name}.py").read_bytes()).hexdigest()}
                      for name in ("runtime_admission", "runtime_benchmark", "runtime_docker", "runtime_journal", "runtime_service", "runtime_timing", "runtime_worker_pool", "runtime_reset")]
    try:
        with timings.recording(session_id=session):
            with runtime_phase("runtime.bootstrap", role="controller"):
                driver = client.api.inspect_container(os.environ["HOSTNAME"])
                if driver["Image"] != manifest["controller_image_id"] or driver["HostConfig"]["NanoCpus"] != manifest["resources"]["controller_cpu"] * 1_000_000_000 or driver["HostConfig"]["Memory"] != manifest["resources"]["controller_memory_bytes"]:
                    raise ValueError("benchmark controller identity or limits drifted")
                catalog = TrustedCandidateCatalog.load(args.source / manifest["candidate_directory"], args.source / "schemas/v1/task-environment-candidate.schema.json")
                config = RuntimeDockerConfiguration(
                    task_environment_lock_path=Path("/unused"), task_environment_lock_schema_path=args.source / "schemas/v1/task-environment-lock.schema.json",
                    dataset_lock_path=args.source / "configs/runtime/axios-5892/dataset-lock.json", dataset_lock_schema_path=args.source / "schemas/v1/dataset-lock.schema.json",
                    evaluator_kernel_root=args.source / "evaluator/repofixlab_evaluator", evaluator_kernel_sha256=manifest["evaluator_kernel_sha256"],
                    runtime_lock_root=Path("/opt/repofixlab/runtime-locks/m6-26-task-v1"),
                    worker_pool_capacity=args.concurrency if args.worker_pool else 0,
                    evaluator_pool_capacity=1 if args.evaluator_pool else 0, reuse_containers=args.reuse)
                backend = DockerRuntimeBackend(client, catalog, config)
                service = RuntimeOperationService(backend, RuntimeOperationJournal(Path("/tmp/runtime-operations")), capacity=args.concurrency)
        tasks = {task["instance_id"]: task for task in manifest["tasks"]}

        def execute_sample(sample: dict, instance_id: str) -> dict:
            with timings.recording(**sample):
                return run_sample(service, tasks[instance_id], args.source, args.output / sample["sample_id"], sample)

        for repetition in range(manifest["repetitions"]):
            for cohort in manifest["cohorts"]:
                clean = True
                samples = []
                for index, instance_id in enumerate(cohort["instance_ids"][:1] if args.pilot else cohort["instance_ids"]):
                    prefix = "wf5" if args.reuse else "wf4" if args.evaluator_pool else "wf3" if args.worker_pool else "wf2" if args.concurrency == 2 else "wf1"
                    sample_id = f"{prefix}-{session}-{repetition}-{cohort['id']}-{index}"
                    samples.append(({"sample_id": sample_id, "attempt_id": sample_id, "cohort": cohort["id"], "repetition": repetition,
                                     "condition": "first_pass" if repetition == 0 else "repeated", "session_id": session}, instance_id))
                if args.worker_pool:
                    with timings.recording(session_id=session, cohort=cohort["id"], repetition=repetition):
                        with runtime_phase("worker.queue_warmup", role="worker"):
                            for sample, instance_id in samples:
                                task = tasks[instance_id]
                                body = {"schema_version": "v1", "request_type": "runtime_preflight", "attempt_id": sample["attempt_id"],
                                        "operation_id": f"{sample['sample_id']}:operation-1", "candidate_id": task["candidate_id"], "instance_id": instance_id}
                                body["request_sha256"] = runtime_request_sha256(body)
                                with timings.recording(**sample):
                                    service.preflight(body)
                            backend.worker_pool.wait_prepared()
                            if backend.evaluator_pool is not None:
                                backend.evaluator_pool.wait_prepared()
                with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                    futures = [pool.submit(execute_sample, sample, instance_id) for sample, instance_id in samples]
                    # Record every admitted attempt, including failures, before
                    # deciding whether the next frozen cohort may start.
                    for future in futures:
                        result = future.result()
                        records.append(result)
                        print(json.dumps(result), flush=True)
                        with (args.output / "samples.ndjson").open("a") as stream:
                            stream.write(json.dumps(result) + "\n")
                            stream.flush()
                            os.fsync(stream.fileno())
                        clean = clean and result["cleanup_clean"]
                if not clean:
                    raise RuntimeError("residual resources block the next cohort")
                if args.pilot:
                    break
            if args.pilot:
                break
    except Exception as error:
        batch_error_class = type(error).__name__
        raise
    finally:
        if service:
            try:
                service.close()
            except Exception as error:
                batch_error_class = batch_error_class or type(error).__name__
        if backend is not None and (backend.worker_pool is not None or backend.evaluator_pool is not None):
            write_json(args.output / "runtime-state.json", {
                "pool_namespace": backend._pool_namespace,
                "pool": backend.worker_pool.snapshot if backend.worker_pool else {},
                **({"evaluator_pool": backend.evaluator_pool.snapshot,
                    "claimed_evaluators": dict(backend._evaluator_owners)} if backend.evaluator_pool else {}),
                "admission": backend.resource_admission.snapshot, "claimed_workers": dict(backend._worker_owners),
                "active_generations": len(backend._active_generations),
            })
        journal_path = Path("/tmp/runtime-operations/journal.jsonl")
        if journal_path.is_file():
            with (args.output / "runtime-journal.jsonl").open("xb") as stream:
                stream.write(journal_path.read_bytes())
                stream.flush()
                os.fsync(stream.fileno())
        resources.close()
        client.close()
        records.extend(timings.records)
        records.extend(resources.records)
        if backend is not None and backend.worker_pool is not None:
            records.extend(backend.worker_pool.records)
        if backend is not None and backend.evaluator_pool is not None:
            records.extend(backend.evaluator_pool.records)
        records.append({"record_type": "batch", "wall_ns": monotonic_ns() - started, "pilot": args.pilot,
                        "execution": {"concurrency": args.concurrency,
                                      "runtime_sources": runtime_sources,
                                      "mode": "concurrent_reset_reuse" if args.reuse else "concurrent_role_pools" if args.evaluator_pool else "concurrent_worker_pool" if args.worker_pool else "concurrent_on_demand" if args.concurrency == 2 else "sequential_on_demand"},
                        "status": "failed" if batch_error_class or any(item["status"] != "completed" or not item.get("consistent") for item in records if item["record_type"] == "sample") else "completed",
                        "error_class": batch_error_class})
        with (args.output / "raw.ndjson").open("w") as stream:
            for record in records:
                stream.write(json.dumps(record, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        write_json(args.output / "report.json", summarize(records, manifest))
    if batch_error_class or any(item["status"] != "completed" or not item.get("consistent") for item in records if item["record_type"] == "sample"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
