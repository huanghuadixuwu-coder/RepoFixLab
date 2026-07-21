from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
from threading import Lock, Thread
from typing import Protocol

from .m3_image_resolver import (
    DATASET_REVISION,
    ELIGIBLE_TASK_COUNT,
    EXPECTED_TASK_COUNT,
    SUPPORTED_TASK_COUNTS,
    _requested_reference,
    _timestamp,
)


PRISTINE_IMAGE = "repofixlab/pristine-harness:m0-726c5461-final"
KERNEL_PATH = Path("/opt/repofixlab/evaluator-kernel/repofixlab_evaluator/m3_task_kernel.py")
_OPERATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_IMAGE_ID = re.compile(r"^sha256:[a-f0-9]{64}$")


class M3PreflightError(RuntimeError):
    """The controller could not produce trustworthy M3 preflight evidence."""


class M3PreflightConflict(M3PreflightError):
    """A preflight operation ID was replayed with different sealed input."""


@dataclass(frozen=True)
class M3PreflightTask:
    instance_id: str
    base_commit: str
    repo: str
    private_task_sha256: str
    source_image_id: str
    adapted_image_reference: str | None = None
    adapted_image_id: str | None = None


@dataclass(frozen=True)
class M3PreflightRequest:
    operation_id: str
    dataset_revision: str
    private_volume: str
    tasks: tuple[M3PreflightTask, ...]


class _ContainerProtocol(Protocol):
    id: str

    def wait(self, timeout: int) -> Mapping[str, object]: ...

    def logs(self, *, stdout: bool, stderr: bool) -> bytes: ...

    def remove(self, *, force: bool) -> None: ...

    def put_archive(self, path: str, data: bytes) -> bool: ...


class _ContainerCollectionProtocol(Protocol):
    def run(self, image: str, command: list[str], **kwargs: object) -> _ContainerProtocol: ...

    def create(self, image: str, command: list[str], **kwargs: object) -> _ContainerProtocol: ...


class _VolumeProtocol(Protocol):
    name: str

    def remove(self, *, force: bool) -> None: ...


class _VolumeCollectionProtocol(Protocol):
    def create(self, *, name: str, labels: Mapping[str, str]) -> _VolumeProtocol: ...


class _ImageProtocol(Protocol):
    id: str


class _ImageCollectionProtocol(Protocol):
    def get(self, name: str) -> _ImageProtocol: ...


class DockerClientProtocol(Protocol):
    containers: _ContainerCollectionProtocol
    volumes: _VolumeCollectionProtocol
    images: _ImageCollectionProtocol


def _canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def _sha256(value: object) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _request_sha256(request: M3PreflightRequest) -> str:
    validate_request(request)
    return _sha256({
        "schema_version": "v1",
        "request_type": "m3_official_image_preflight",
        "operation_id": request.operation_id,
        "dataset_revision": request.dataset_revision,
        "private_volume": request.private_volume,
        "tasks": [
            {
                "instance_id": task.instance_id,
                "base_commit": task.base_commit,
                "repo": task.repo,
                "private_task_sha256": task.private_task_sha256,
                "source_image_id": task.source_image_id,
                **(
                    {}
                    if task.adapted_image_reference is None
                    else {
                        "adapted_image_reference": task.adapted_image_reference,
                        "adapted_image_id": task.adapted_image_id,
                    }
                ),
            }
            for task in request.tasks
        ],
    })


def validate_request(request: M3PreflightRequest) -> M3PreflightRequest:
    if _OPERATION_ID.fullmatch(request.operation_id) is None:
        raise M3PreflightError("M3 preflight operation ID is malformed")
    if request.dataset_revision != DATASET_REVISION:
        raise M3PreflightError("M3 preflight dataset revision drifted")
    if not re.fullmatch(r"dataset-private-g-[a-z0-9-]{1,63}", request.private_volume):
        raise M3PreflightError("M3 preflight private volume is malformed")
    if len(request.tasks) not in SUPPORTED_TASK_COUNTS:
        raise M3PreflightError("M3 preflight requires exactly 43 candidate tasks or 26 eligible tasks")
    if tuple(task.instance_id for task in request.tasks) != tuple(sorted(task.instance_id for task in request.tasks)):
        raise M3PreflightError("M3 preflight tasks must be sorted by instance ID")
    if len({task.instance_id for task in request.tasks}) != len(request.tasks):
        raise M3PreflightError("M3 preflight tasks are not unique")
    for task in request.tasks:
        _requested_reference(task.instance_id)
        if (
            _COMMIT.fullmatch(task.base_commit) is None
            or not task.repo
            or task.repo.strip() != task.repo
            or any(character.isspace() for character in task.repo)
            or _SHA256.fullmatch(task.private_task_sha256) is None
            or _IMAGE_ID.fullmatch(task.source_image_id) is None
        ):
            raise M3PreflightError("M3 preflight task has malformed sealed identity")
        if (task.adapted_image_reference is None) != (task.adapted_image_id is None):
            raise M3PreflightError("M3 preflight adapted image identity must be complete or absent")
        if task.adapted_image_reference is not None:
            if (
                len(request.tasks) != ELIGIBLE_TASK_COUNT
                or not task.adapted_image_reference.startswith("repofixlab-m6-")
                or _IMAGE_ID.fullmatch(task.adapted_image_id or "") is None
            ):
                raise M3PreflightError("M3 preflight adapted image binding is malformed")
    return request


def _volume_name(operation_id: str, task: M3PreflightTask, kind: str) -> str:
    digest = hashlib.sha256(f"{operation_id}\0{task.instance_id}\0{kind}".encode("utf-8")).hexdigest()[:24]
    return f"repofixlab-m3-{kind}-{digest}"


def _kernel_archive(content: bytes) -> bytes:
    with io.BytesIO() as stream:
        with tarfile.open(fileobj=stream, mode="w") as archive:
            info = tarfile.TarInfo("m3_task_kernel.py")
            info.size = len(content)
            info.mode = 0o444
            archive.addfile(info, io.BytesIO(content))
        return stream.getvalue()


def _parse_report(raw: bytes, instance_id: str, mode: str, probe_kind: str) -> dict[str, object]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise M3PreflightError("M3 preflight container returned malformed JSON") from error
    required = {
        "schema_version", "record_type", "harness_mode", "probe_kind", "instance_id", "base_commit",
        "candidate_patch_sha256", "test_patch_sha256", "candidate_patch_apply_status", "test_patch_apply_status",
        "test_executed", "exit_code", "timed_out", "duration_ms", "test_log_sha256", "resolved",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value["schema_version"] != "v1"
        or value["record_type"] != "m3_official_image_preflight"
        or value["harness_mode"] != mode
        or value["probe_kind"] != probe_kind
        or value["instance_id"] != instance_id
        or not isinstance(value["resolved"], bool)
        or not isinstance(value["test_executed"], bool)
    ):
        raise M3PreflightError("M3 preflight container report violates its public contract")
    return value


def _parse_grade_report(raw: bytes, instance_id: str, test_log_sha256: object) -> dict[str, object]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise M3PreflightError("M3 official grader returned malformed JSON") from error
    required = {
        "schema_version", "record_type", "instance_id", "test_log_sha256", "found", "resolved",
        "status_map_sha256", "fail_to_pass", "pass_to_pass",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value["schema_version"] != "v1"
        or value["record_type"] != "m3_official_log_grade"
        or value["instance_id"] != instance_id
        or value["test_log_sha256"] != test_log_sha256
        or not isinstance(value["found"], bool)
        or not isinstance(value["resolved"], bool)
        or _SHA256.fullmatch(value["status_map_sha256"]) is None
    ):
        raise M3PreflightError("M3 official grader report violates its public contract")
    for key in ("fail_to_pass", "pass_to_pass"):
        counts = value[key]
        if (
            not isinstance(counts, dict)
            or set(counts) != {"total", "passed", "failed"}
            or any(not isinstance(counts[name], int) or counts[name] < 0 for name in counts)
            or counts["passed"] + counts["failed"] != counts["total"]
        ):
            raise M3PreflightError("M3 official grader report has invalid aggregate counts")
    return value


class M3PreflightService:
    def __init__(self, client: DockerClientProtocol, operation_root: Path, private_volume: str) -> None:
        self._client = client
        self._operation_root = operation_root
        if not re.fullmatch(r"dataset-private-g-[a-z0-9-]{1,63}", private_volume):
            raise M3PreflightError("configured M3 private volume is malformed")
        self._private_volume = private_volume
        self._lock = Lock()
        self._active: set[str] = set()

    def start(self, request: M3PreflightRequest) -> tuple[dict[str, object], bool]:
        if request.private_volume != self._private_volume:
            raise M3PreflightError("M3 preflight request does not bind the controller configured private volume")
        request_hash = _request_sha256(request)
        self._operation_root.mkdir(parents=True, exist_ok=True)
        path = self._operation_root / f"{request.operation_id}.json"
        with self._lock:
            if path.exists():
                record = self._load(path, request_hash)
                if record.get("status") == "running" and request.operation_id not in self._active:
                    record = {**record, "status": "failed", "failure_code": "controller_restarted", "updated_at": _timestamp()}
                    self._write(path, record)
                return record, True
            now = _timestamp()
            record = {"schema_version": "v1", "record_type": "m3_official_image_preflight", "operation_id": request.operation_id, "request_sha256": request_hash, "status": "running", "total_task_count": len(request.tasks), "completed_task_count": 0, "created_at": now, "updated_at": now}
            self._write(path, record)
            self._active.add(request.operation_id)
            Thread(target=self._run_background, args=(path, request, request_hash), daemon=True, name=f"repofixlab-m3-preflight-{request.operation_id}").start()
            return record, False

    def _run_background(self, path: Path, request: M3PreflightRequest, request_hash: str) -> None:
        try:
            reports: list[dict[str, object]] = []
            for index, task in enumerate(request.tasks, start=1):
                reports.append(self._run_task(request, task))
                with self._lock:
                    current = self._load(path, request_hash)
                    self._write(path, {**current, "completed_task_count": index, "updated_at": _timestamp()})
            all_passed = all(bool(report["passed"]) for report in reports)
            with self._lock:
                current = self._load(path, request_hash)
                self._write(path, {**current, "status": "completed" if all_passed else "failed", "updated_at": _timestamp(), "task_reports": reports, **({} if all_passed else {"failure_code": "official_preflight_failed"})})
        except Exception:
            with self._lock:
                current = self._load(path, request_hash)
                self._write(path, {**current, "status": "failed", "failure_code": "controller_preflight_error", "updated_at": _timestamp()})
        finally:
            with self._lock:
                self._active.discard(request.operation_id)

    def _run_task(self, request: M3PreflightRequest, task: M3PreflightTask) -> dict[str, object]:
        source_reference = _requested_reference(task.instance_id)
        source_image = self._client.images.get(source_reference)
        if getattr(source_image, "id", None) != task.source_image_id:
            raise M3PreflightError("official source image no longer matches OfficialImageSourceLock")
        adapted_reference = task.adapted_image_reference or source_reference
        adapted_image = self._client.images.get(adapted_reference)
        expected_adapted_id = task.adapted_image_id or task.source_image_id
        if getattr(adapted_image, "id", None) != expected_adapted_id:
            raise M3PreflightError("adapted image no longer matches its sealed local image ID")
        kernel = KERNEL_PATH.read_bytes()
        kernel_volume = self._client.volumes.create(name=_volume_name(request.operation_id, task, "kernel"), labels={"io.repofixlab.m3-operation": request.operation_id})
        private_volume = self._client.volumes.create(name=_volume_name(request.operation_id, task, "private"), labels={"io.repofixlab.m3-operation": request.operation_id})
        try:
            initializer = self._client.containers.create(PRISTINE_IMAGE, ["-c", "sleep 30"], entrypoint=["/bin/sh"], volumes={kernel_volume.name: {"bind": "/kernel", "mode": "rw"}})
            try:
                if not initializer.put_archive("/kernel", _kernel_archive(kernel)):
                    raise M3PreflightError("controller could not inject the sealed M3 kernel")
            finally:
                initializer.remove(force=True)
            permission = self._client.containers.run(PRISTINE_IMAGE, ["-c", "chown 65532:65532 /work && chmod 700 /work"], entrypoint=["/bin/sh"], detach=True, network_mode="none", user="0:0", volumes={private_volume.name: {"bind": "/work", "mode": "rw"}})
            try:
                if permission.wait(timeout=30).get("StatusCode") != 0:
                    raise M3PreflightError("controller could not initialize M3 private output")
            finally:
                permission.remove(force=True)
            prepare = self._client.containers.run(PRISTINE_IMAGE, ["-m", "m3_task_kernel", "prepare", "--dataset-task", f"/data/private/tasks/{task.instance_id}.json", "--dataset-root", "/data/private", "--output-root", "/run/repofixlab/private", "--expected-task-sha256", task.private_task_sha256, "--instance-id", task.instance_id, "--base-commit", task.base_commit, "--repo", task.repo], entrypoint=["python"], detach=True, network_mode="none", read_only=True, cap_drop=["ALL"], security_opt=["no-new-privileges"], tmpfs={"/tmp": "rw,noexec,nosuid,size=64m"}, user="65532:65532", volumes={request.private_volume: {"bind": "/data/private", "mode": "ro"}, private_volume.name: {"bind": "/run/repofixlab/private", "mode": "rw"}, kernel_volume.name: {"bind": "/opt/repofixlab", "mode": "ro"}})
            try:
                if prepare.wait(timeout=120).get("StatusCode") != 0:
                    raise M3PreflightError("M3 private task preparation failed")
            finally:
                prepare.remove(force=True)
            probes: list[dict[str, object]] = []
            for mode in ("pristine", "adapted"):
                task_image = source_reference if mode == "pristine" else adapted_reference
                for probe_kind in ("base", "gold"):
                    evidence = self._client.volumes.create(name=_volume_name(request.operation_id, task, f"evidence-{mode}-{probe_kind}"), labels={"io.repofixlab.m3-operation": request.operation_id})
                    evaluator = self._client.containers.run(task_image, ["/opt/repofixlab/m3_task_kernel.py", "run", "--mode", mode, "--probe-kind", probe_kind, "--private-root", "/run/repofixlab/private", "--evidence-root", "/run/repofixlab/evidence", "--instance-id", task.instance_id, "--base-commit", task.base_commit, "--timeout-seconds", "300"], entrypoint=["python3"], detach=True, platform="linux/amd64", network_mode="none", cap_drop=["ALL"], security_opt=["no-new-privileges"], pids_limit=256, mem_limit="4g", nano_cpus=2_000_000_000, tmpfs={"/tmp": "rw,noexec,nosuid,size=128m"}, volumes={private_volume.name: {"bind": "/run/repofixlab/private", "mode": "ro"}, evidence.name: {"bind": "/run/repofixlab/evidence", "mode": "rw"}, kernel_volume.name: {"bind": "/opt/repofixlab", "mode": "ro"}}, labels={"io.repofixlab.m3-operation": request.operation_id, "io.repofixlab.instance-id": task.instance_id})
                    try:
                        status = evaluator.wait(timeout=360)
                        if status.get("StatusCode") != 0:
                            raise M3PreflightError("official task preflight container failed")
                        report = _parse_report(evaluator.logs(stdout=True, stderr=False), task.instance_id, mode, probe_kind)
                        if report["test_executed"]:
                            grader = self._client.containers.run(PRISTINE_IMAGE, ["-m", "m3_task_kernel", "grade", "--private-root", "/run/repofixlab/private", "--evidence-root", "/run/repofixlab/evidence", "--instance-id", task.instance_id, "--base-commit", task.base_commit, "--repo", task.repo], entrypoint=["python"], detach=True, network_mode="none", read_only=True, cap_drop=["ALL"], security_opt=["no-new-privileges"], tmpfs={"/tmp": "rw,noexec,nosuid,size=64m"}, user="65532:65532", volumes={private_volume.name: {"bind": "/run/repofixlab/private", "mode": "ro"}, evidence.name: {"bind": "/run/repofixlab/evidence", "mode": "ro"}, kernel_volume.name: {"bind": "/opt/repofixlab", "mode": "ro"}})
                            try:
                                if grader.wait(timeout=60).get("StatusCode") != 0:
                                    raise M3PreflightError("official SWE-bench grader container failed")
                                grade = _parse_grade_report(
                                    grader.logs(stdout=True, stderr=False),
                                    task.instance_id,
                                    report["test_log_sha256"],
                                )
                            finally:
                                grader.remove(force=True)
                            report["resolved"] = grade["resolved"]
                            report["official_grading"] = grade
                        probes.append(report)
                    finally:
                        evaluator.remove(force=True)
                        evidence.remove(force=True)
            passed = all(
                report["test_executed"]
                and isinstance(report.get("official_grading"), dict)
                and report["official_grading"].get("found") is True
                and (not report["resolved"] if report["probe_kind"] == "base" else report["resolved"])
                for report in probes
            )
            return {"instance_id": task.instance_id, "base_commit": task.base_commit, "source_image_id": task.source_image_id, "adapted_image_id": expected_adapted_id, "passed": passed, "probes": probes}
        finally:
            private_volume.remove(force=True)
            kernel_volume.remove(force=True)

    @staticmethod
    def _write(path: Path, record: Mapping[str, object]) -> None:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_bytes(_canonical_bytes(record))
        os.replace(temporary, path)

    @staticmethod
    def _load(path: Path, request_hash: str) -> dict[str, object]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise M3PreflightError("M3 preflight journal is unreadable") from error
        if not isinstance(value, dict) or value.get("request_sha256") != request_hash or value.get("record_type") != "m3_official_image_preflight":
            raise M3PreflightConflict("M3 preflight operation conflicts with immutable input")
        return value
