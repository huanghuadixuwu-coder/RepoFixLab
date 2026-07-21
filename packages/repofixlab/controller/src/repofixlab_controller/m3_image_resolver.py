from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path
import re
from threading import Lock, Thread
from typing import Protocol


DATASET_REVISION = "2b7aced941b4873e9cad3e76abbae93f481d1beb"
HARNESS_REVISION = "726c5461e2ef52d83cf1ea2107870a8bb3328d57"
EXPECTED_TASK_COUNT = 43
ELIGIBLE_TASK_COUNT = 26
SUPPORTED_TASK_COUNTS = frozenset({EXPECTED_TASK_COUNT, ELIGIBLE_TASK_COUNT})
PLATFORM = "linux/amd64"
_INSTANCE_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,199}__[a-z0-9][a-z0-9_.-]{0,199}$")
_IMAGE_ID = re.compile(r"^sha256:[a-f0-9]{64}$")
_REPOSITORY_DIGEST = re.compile(r"^[^\s@]+@sha256:[a-f0-9]{64}$")
_OPERATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


class M3ImageResolutionError(RuntimeError):
    """A source image could not be mechanically resolved and sealed."""


class M3ImageResolutionConflict(M3ImageResolutionError):
    """An operation ID was replayed with different immutable input."""


class M3ImageResolutionNotFound(M3ImageResolutionError):
    """No persisted M3 image resolution exists for the requested operation."""


class ImageProtocol(Protocol):
    id: str
    attrs: Mapping[str, object]


class ImageCollectionProtocol(Protocol):
    def pull(self, repository: str, *, platform: str) -> ImageProtocol: ...

    def get(self, name: str) -> ImageProtocol: ...


class DockerClientProtocol(Protocol):
    images: ImageCollectionProtocol


@dataclass(frozen=True)
class M3ImageResolutionRequest:
    operation_id: str
    dataset_revision: str
    instance_ids: tuple[str, ...]


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _sha256(value: object) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _lock_id(images: Sequence[Mapping[str, object]], seal_sha256: str) -> str:
    if len(images) not in SUPPORTED_TASK_COUNTS:
        raise M3ImageResolutionError("M3 official image lock must contain either 43 candidate images or 26 eligible images")
    return f"official-images-v1-set-{len(images)}-{seal_sha256[:16]}"


def _requested_reference(instance_id: str) -> str:
    if _INSTANCE_ID.fullmatch(instance_id) is None:
        raise M3ImageResolutionError("M3 instance ID is malformed")
    normalized = instance_id.lower().replace("__", "_1776_")
    return f"swebench/sweb.eval.x86_64.{normalized}:latest"


def _image_repository_digest(image: ImageProtocol, requested_reference: str) -> str:
    repository = requested_reference.rsplit(":", 1)[0]
    repo_digests = image.attrs.get("RepoDigests")
    if not isinstance(repo_digests, list):
        raise M3ImageResolutionError("pulled source image does not expose RepoDigests")
    candidates = sorted(
        value
        for value in repo_digests
        if isinstance(value, str) and value.startswith(f"{repository}@sha256:") and _REPOSITORY_DIGEST.fullmatch(value)
    )
    if len(candidates) != 1:
        raise M3ImageResolutionError("pulled source image does not expose one matching repository digest")
    return candidates[0]


def _image_platform(image: ImageProtocol) -> str:
    os_name = image.attrs.get("Os")
    architecture = image.attrs.get("Architecture")
    if os_name != "linux" or architecture != "amd64":
        raise M3ImageResolutionError("pulled source image platform is not linux/amd64")
    return PLATFORM


def _image_id(image: ImageProtocol) -> str:
    inspect_id = image.attrs.get("Id")
    if not isinstance(inspect_id, str) or image.id != inspect_id or _IMAGE_ID.fullmatch(inspect_id) is None:
        raise M3ImageResolutionError("pulled source image ID is malformed or inconsistent")
    return inspect_id


def _registry_response_sha256(image: ImageProtocol, requested_reference: str, repository_digest: str) -> str:
    repo_digests = image.attrs.get("RepoDigests")
    if not isinstance(repo_digests, list) or not all(isinstance(value, str) for value in repo_digests):
        raise M3ImageResolutionError("pulled source image registry response is malformed")
    return _sha256(
        {
            "requested_reference": requested_reference,
            "repository_digest": repository_digest,
            "repo_digests": sorted(repo_digests),
            "image_id": _image_id(image),
            "platform": _image_platform(image),
        }
    )


def _semantic_subset(
    dataset_revision: str,
    images: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    return {
        "schema_version": "v1",
        "lock_type": "official_image_source",
        "dataset_revision": dataset_revision,
        "harness_revision": HARNESS_REVISION,
        "images": [
            {
                "image_key": image["image_key"],
                "local_image_id": image["local_image_id"],
                "platform": image["platform"],
                "registry_response_sha256": image["registry_response_sha256"],
                "repository_digest": image["repository_digest"],
                "requested_reference": image["requested_reference"],
            }
            for image in images
        ],
    }


def _pull_or_load_cached_image(
    client: DockerClientProtocol,
    requested_reference: str,
    instance_id: str,
) -> tuple[ImageProtocol, str]:
    try:
        return client.images.pull(requested_reference, platform=PLATFORM), "pull"
    except Exception:
        try:
            return client.images.get(requested_reference), "local_cache"
        except Exception as cache_error:
            raise M3ImageResolutionError(f"failed to pull official source image for {instance_id}") from cache_error


def validate_request(request: M3ImageResolutionRequest) -> M3ImageResolutionRequest:
    if _OPERATION_ID.fullmatch(request.operation_id) is None:
        raise M3ImageResolutionError("M3 operation ID is malformed")
    if request.dataset_revision != DATASET_REVISION:
        raise M3ImageResolutionError("M3 image resolution dataset revision drifted")
    if len(request.instance_ids) not in SUPPORTED_TASK_COUNTS:
        raise M3ImageResolutionError("M3 image resolution requires exactly 43 candidate IDs or 26 eligible IDs")
    if tuple(sorted(request.instance_ids)) != request.instance_ids or len(set(request.instance_ids)) != len(request.instance_ids):
        raise M3ImageResolutionError("M3 instance IDs must be unique and canonical-order sorted")
    for instance_id in request.instance_ids:
        _requested_reference(instance_id)
    return request


def request_sha256(request: M3ImageResolutionRequest) -> str:
    validate_request(request)
    return _sha256(
        {
            "schema_version": "v1",
            "request_type": "m3_official_image_resolution",
            "operation_id": request.operation_id,
            "dataset_revision": request.dataset_revision,
            "harness_revision": HARNESS_REVISION,
            "instance_ids": list(request.instance_ids),
        }
    )


def resolve_official_image_lock(
    client: DockerClientProtocol,
    request: M3ImageResolutionRequest,
    *,
    resolved_at: str,
    on_image_resolved: Callable[[int, str, str], None] | None = None,
) -> dict[str, object]:
    validate_request(request)
    if not resolved_at.endswith("Z") or not isinstance(datetime.fromisoformat(resolved_at.replace("Z", "+00:00")), datetime):
        raise M3ImageResolutionError("M3 resolution timestamp is invalid")
    images: list[dict[str, object]] = []
    for instance_id in request.instance_ids:
        requested_reference = _requested_reference(instance_id)
        image, acquisition = _pull_or_load_cached_image(client, requested_reference, instance_id)
        repository_digest = _image_repository_digest(image, requested_reference)
        images.append(
            {
                "image_key": instance_id,
                "requested_reference": requested_reference,
                "repository_digest": repository_digest,
                "local_image_id": _image_id(image),
                "platform": _image_platform(image),
                "registry_response_sha256": _registry_response_sha256(image, requested_reference, repository_digest),
                "resolved_at": resolved_at,
            }
        )
        if on_image_resolved is not None:
            on_image_resolved(len(images), instance_id, acquisition)
    seal = _sha256(_semantic_subset(request.dataset_revision, images))
    return {
        "schema_version": "v1",
        "lock_type": "official_image_source",
        "lock_id": _lock_id(images, seal),
        "dataset_revision": request.dataset_revision,
        "harness_revision": HARNESS_REVISION,
        "images": images,
        "seal_sha256": seal,
        "created_at": resolved_at,
    }


class M3ImageResolutionService:
    def __init__(self, client: DockerClientProtocol, operation_root: Path) -> None:
        self._client = client
        self._operation_root = operation_root
        self._lock = Lock()
        self._active_operation_ids: set[str] = set()

    def resolve(self, request: M3ImageResolutionRequest) -> tuple[dict[str, object], bool]:
        request_hash = request_sha256(request)
        self._operation_root.mkdir(parents=True, exist_ok=True)
        path = self._operation_root / f"{request.operation_id}.json"
        with self._lock:
            if path.exists():
                record = self._load_record(path, request_hash)
                lock = record.get("official_image_source_lock")
                if record.get("status") != "completed" or not isinstance(lock, dict):
                    raise M3ImageResolutionConflict("M3 operation ID is already reserved by an unfinished operation")
                return lock, True
            result = resolve_official_image_lock(self._client, request, resolved_at=_timestamp())
            self._write_record(path, self._completed_record(request, request_hash, result))
            return result, False

    def start(self, request: M3ImageResolutionRequest) -> tuple[dict[str, object], bool]:
        request_hash = request_sha256(request)
        self._operation_root.mkdir(parents=True, exist_ok=True)
        path = self._operation_root / f"{request.operation_id}.json"
        with self._lock:
            if path.exists():
                record = self._load_record(path, request_hash)
                if record.get("status") == "running" and request.operation_id not in self._active_operation_ids:
                    record = {
                        **record,
                        "status": "failed",
                        "failure_code": "controller_restarted",
                        "failure_detail": "controller restarted before image resolution completed",
                        "updated_at": _timestamp(),
                    }
                    self._write_record(path, record)
                return record, True
            created_at = _timestamp()
            record = {
                "schema_version": "v1",
                "record_type": "m3_official_image_resolution",
                "operation_id": request.operation_id,
                "request_sha256": request_hash,
                "status": "running",
                "total_image_count": len(request.instance_ids),
                "completed_image_count": 0,
                "pulled_image_count": 0,
                "local_cache_image_count": 0,
                "created_at": created_at,
                "updated_at": created_at,
            }
            self._write_record(path, record)
            self._active_operation_ids.add(request.operation_id)
            try:
                Thread(
                    target=self._resolve_in_background,
                    args=(path, request, request_hash),
                    daemon=True,
                    name=f"repofixlab-m3-{request.operation_id}",
                ).start()
            except Exception as error:
                self._active_operation_ids.discard(request.operation_id)
                failed = {
                    **record,
                    "status": "failed",
                    "failure_code": "controller_background_start_failed",
                    "failure_detail": "controller could not start image resolution",
                    "updated_at": _timestamp(),
                }
                self._write_record(path, failed)
                raise M3ImageResolutionError("controller could not start M3 image resolution") from error
            return record, False

    def _resolve_in_background(
        self,
        path: Path,
        request: M3ImageResolutionRequest,
        request_hash: str,
    ) -> None:
        try:
            lock = resolve_official_image_lock(
                self._client,
                request,
                resolved_at=_timestamp(),
                on_image_resolved=lambda count, _, acquisition: self._record_progress(
                    path,
                    request_hash,
                    count,
                    acquisition,
                ),
            )
            with self._lock:
                running_record = self._load_record(path, request_hash)
                created_at = running_record.get("created_at")
                if not isinstance(created_at, str):
                    raise M3ImageResolutionError("M3 image resolution progress record is missing its creation time")
                pulled_image_count = running_record.get("pulled_image_count")
                local_cache_image_count = running_record.get("local_cache_image_count")
                if not isinstance(pulled_image_count, int) or not isinstance(local_cache_image_count, int):
                    raise M3ImageResolutionError("M3 image resolution progress record has invalid acquisition counters")
                self._write_record(
                    path,
                    self._completed_record(
                        request,
                        request_hash,
                        lock,
                        created_at,
                        pulled_image_count,
                        local_cache_image_count,
                    ),
                )
        except M3ImageResolutionError as error:
            self._record_failure(path, request_hash, "source_image_resolution_rejected", str(error))
        except Exception:
            self._record_failure(
                path,
                request_hash,
                "controller_internal_error",
                "controller encountered an unexpected image resolution error",
            )
        finally:
            with self._lock:
                self._active_operation_ids.discard(request.operation_id)

    def _record_progress(
        self,
        path: Path,
        request_hash: str,
        completed_image_count: int,
        acquisition: str,
    ) -> None:
        with self._lock:
            record = self._load_record(path, request_hash)
            if record.get("status") != "running":
                raise M3ImageResolutionError("M3 image resolution progress record is not running")
            pulled_image_count = record.get("pulled_image_count")
            local_cache_image_count = record.get("local_cache_image_count")
            if not isinstance(pulled_image_count, int) or not isinstance(local_cache_image_count, int):
                raise M3ImageResolutionError("M3 image resolution progress record has invalid acquisition counters")
            if acquisition == "pull":
                pulled_image_count += 1
            elif acquisition == "local_cache":
                local_cache_image_count += 1
            else:
                raise M3ImageResolutionError("M3 image resolution acquisition mode is invalid")
            self._write_record(
                path,
                {
                    **record,
                    "completed_image_count": completed_image_count,
                    "pulled_image_count": pulled_image_count,
                    "local_cache_image_count": local_cache_image_count,
                    "updated_at": _timestamp(),
                },
            )

    def _record_failure(
        self,
        path: Path,
        request_hash: str,
        failure_code: str,
        failure_detail: str,
    ) -> None:
        with self._lock:
            record = self._load_record(path, request_hash)
            self._write_record(
                path,
                {
                    **record,
                    "status": "failed",
                    "failure_code": failure_code,
                    "failure_detail": failure_detail,
                    "updated_at": _timestamp(),
                },
            )

    @staticmethod
    def _completed_record(
        request: M3ImageResolutionRequest,
        request_hash: str,
        lock: dict[str, object],
        created_at: str | None = None,
        pulled_image_count: int | None = None,
        local_cache_image_count: int = 0,
    ) -> dict[str, object]:
        completed_at = _timestamp()
        image_count = len(request.instance_ids)
        return {
            "schema_version": "v1",
            "record_type": "m3_official_image_resolution",
            "operation_id": request.operation_id,
            "request_sha256": request_hash,
            "status": "completed",
            "total_image_count": image_count,
            "completed_image_count": image_count,
            "pulled_image_count": image_count if pulled_image_count is None else pulled_image_count,
            "local_cache_image_count": local_cache_image_count,
            "created_at": completed_at if created_at is None else created_at,
            "updated_at": completed_at,
            "official_image_source_lock": lock,
        }

    @staticmethod
    def _write_record(path: Path, record: Mapping[str, object]) -> None:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as handle:
                handle.write(_canonical_bytes(record))
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            os.close(descriptor)
        try:
            os.replace(temporary, path)
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        finally:
            if temporary.exists():
                temporary.unlink()

    @staticmethod
    def _load_record(path: Path, expected_request_sha256: str) -> dict[str, object]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise M3ImageResolutionError("persisted M3 image resolution is unreadable") from error
        if (
            not isinstance(value, dict)
            or value.get("request_sha256") != expected_request_sha256
            or value.get("record_type") != "m3_official_image_resolution"
            or value.get("status") not in {"running", "completed", "failed"}
        ):
            raise M3ImageResolutionConflict("M3 operation ID conflicts with persisted immutable input")
        return value
