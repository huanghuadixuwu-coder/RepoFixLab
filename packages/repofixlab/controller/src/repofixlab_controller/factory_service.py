from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
from threading import BoundedSemaphore, Event, Lock
from types import MappingProxyType

from jsonschema import Draft202012Validator

from .container_factory import (
    AXIOS_SMOKE_INSTANCE_ID,
    IMAGE_PROVENANCE_LABEL,
    TASK_ROLE_FACTORY_PROBE_PROFILE,
    CandidateLaunchDefinition,
    ControllerExecutionEvidence,
    DockerClientProtocol,
    ManagedVolumePolicy,
    ResolvedProbeRequest,
    RoleContainerFactory,
    RoleLaunchPolicy,
    TaskRoleFactoryProbeReport,
    TmpfsPolicy,
    TrustedCandidateResolver,
    controller_mount_signatures_match_exact_allowlist,
    inspect_controller_execution,
    task_role_factory_probe_request_sha256,
)


FACTORY_ROLE_COMMAND = ("node", "/opt/repofixlab/role-probe.mjs")
FACTORY_IMAGE_ENVIRONMENT_ALLOWLIST = (
    "CHROME_BIN",
    "CHROME_PATH",
    "DEBIAN_FRONTEND",
    "HOME",
    "LANG",
    "LC_ALL",
    "NVM_DIR",
    "PATH",
    "TZ",
)
IMAGE_ROLE_PROBE_LABEL = "io.repofixlab.role-probe-sha256"
IMAGE_SANITIZER_LABEL = "io.repofixlab.sanitizer-sha256"
IMAGE_INSTANCE_LABEL = "io.repofixlab.instance-id"
IMAGE_BASE_COMMIT_LABEL = "io.repofixlab.base-commit"
FACTORY_TMPFS_OPTIONS: Mapping[str, str] = MappingProxyType(
    {
        "/tmp": "rw,noexec,nosuid,nodev,size=64m",
        "/run/repofixlab": "rw,noexec,nosuid,nodev,size=16m",
    }
)

_OPERATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_IMAGE_ID = re.compile(r"^sha256:[a-f0-9]{64}$")
_CONTAINER_HOSTNAME = re.compile(r"^[a-f0-9]{12,64}$")
_ENVIRONMENT_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
_PROFILE_ID_PREFIX = "task-environment-profile-v1-axios-5892"
_CANDIDATE_ID_PREFIX = "task-environment-candidate-v1-axios-5892"
_SENSITIVE_ENVIRONMENT_NAMES = frozenset(
    {"ZHIPU_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DOCKER_HOST"}
)
_VOLUME_KEYS: Mapping[str, str] = MappingProxyType(
    {
        "/testbed": "testbed",
        "/output": "output",
        "/evaluation": "evaluation",
    }
)
_JOURNAL_KEYS = frozenset(
    {
        "schema_version",
        "record_type",
        "event",
        "sequence",
        "operation_id",
        "candidate_id",
        "candidate_sha256",
        "instance_id",
        "request_sha256",
        "http_request_sha256",
        "at",
        "report_sha256",
        "previous_record_sha256",
        "record_sha256",
    }
)


class CandidateCatalogError(RuntimeError):
    """A trusted-candidate catalog failed a startup hard gate."""


class FactoryOperationConflict(RuntimeError):
    """An operation ID is already bound to a different HTTP request."""


class FactoryCapacityBusy(RuntimeError):
    """The single global factory capacity slot is occupied."""


class FactoryOperationRejected(RuntimeError):
    """A narrow factory request does not bind a trusted candidate."""


class FactoryRecoveryError(RuntimeError):
    """Persistent operation state cannot be recovered safely."""


class FactoryServiceUnavailable(RuntimeError):
    """The factory cannot safely admit or replay operations."""


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


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _reject_json_constant(value: str) -> object:
    raise CandidateCatalogError(f"non-finite JSON value is forbidden: {value}")


def _unique_json_object(pairs: Sequence[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for name, item in pairs:
        if name in value:
            raise CandidateCatalogError(f"duplicate JSON member is forbidden: {name}")
        value[name] = item
    return value


def _read_strict_json(path: Path) -> object:
    try:
        size = path.stat().st_size
    except OSError as error:
        raise CandidateCatalogError("candidate file metadata is unavailable") from error
    if size < 2 or size > 1024 * 1024:
        raise CandidateCatalogError("candidate file size is outside the trusted limit")
    try:
        content = path.read_text(encoding="utf-8")
        return json.loads(
            content,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except CandidateCatalogError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise CandidateCatalogError("candidate file is not strict UTF-8 JSON") from error


def _filesystem_is_read_only(path: Path) -> bool:
    try:
        return bool(os.statvfs(path).f_flag & os.ST_RDONLY)
    except OSError as error:
        raise CandidateCatalogError("candidate directory mount flags are unavailable") from error


def _required_mapping(value: object, description: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise CandidateCatalogError(f"{description} is malformed")
    return value


def _required_string(value: object, description: str) -> str:
    if not isinstance(value, str) or not value:
        raise CandidateCatalogError(f"{description} is malformed")
    return value


def _required_int(value: object, description: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CandidateCatalogError(f"{description} is malformed")
    return value


def _profile_id(role: str, kind: str, body: Mapping[str, object]) -> str:
    return f"{_PROFILE_ID_PREFIX}-{role}-{kind}-{_canonical_sha256(body)}"


def _verify_role_profile(
    role: str,
    kind: str,
    profile_value: object,
) -> Mapping[str, object]:
    profile = _required_mapping(profile_value, f"{role} {kind} profile")
    actual_hash = _required_string(
        profile.get("profile_sha256"), f"{role} {kind} profile SHA-256"
    )
    unsigned = dict(profile)
    unsigned.pop("profile_sha256", None)
    actual_id = _required_string(
        unsigned.get("profile_id"), f"{role} {kind} profile ID"
    )
    body = dict(unsigned)
    body.pop("profile_id", None)
    if actual_id != _profile_id(role, kind, body):
        raise CandidateCatalogError(
            f"{role} {kind} profile ID does not match canonical content"
        )
    if actual_hash != _canonical_sha256(unsigned):
        raise CandidateCatalogError(
            f"{role} {kind} profile SHA-256 does not match canonical content"
        )
    return profile


def _verify_candidate_semantics(value: Mapping[str, object]) -> None:
    dataset_lock = _required_mapping(value.get("dataset_lock"), "dataset lock")
    official_lock = _required_mapping(
        value.get("official_image_source_lock"), "official image source lock"
    )
    if (
        dataset_lock.get("lock_id") == official_lock.get("lock_id")
        or dataset_lock.get("lock_sha256") == official_lock.get("lock_sha256")
    ):
        raise CandidateCatalogError(
            "dataset and official image source lock references are not independent"
        )

    roles = _required_mapping(value.get("roles"), "candidate roles")
    worker = _required_mapping(roles.get("worker"), "worker candidate")
    evaluator = _required_mapping(roles.get("evaluator"), "evaluator candidate")
    worker_image = _required_mapping(worker.get("image"), "worker image")
    evaluator_image = _required_mapping(evaluator.get("image"), "evaluator image")
    if (
        worker_image.get("local_image_id") == evaluator_image.get("local_image_id")
        or worker_image.get("provenance_sha256")
        == evaluator_image.get("provenance_sha256")
    ):
        raise CandidateCatalogError(
            "Worker and Evaluator images are not independently locked"
        )

    component_hashes = {
        _required_string(value.get("probe_sha256"), "candidate probe SHA-256"),
        _required_string(
            value.get("sanitizer_sha256"), "candidate sanitizer SHA-256"
        ),
        _required_string(value.get("adapter_sha256"), "candidate adapter SHA-256"),
    }
    if len(component_hashes) != 3:
        raise CandidateCatalogError(
            "probe, sanitizer, and adapter bindings are not independent"
        )

    for role, role_value in (("worker", worker), ("evaluator", evaluator)):
        security = _verify_role_profile(
            role, "security", role_value.get("security_profile")
        )
        resources = _verify_role_profile(
            role, "resource", role_value.get("resource_profile")
        )
        filesystem = _verify_role_profile(
            role, "filesystem", role_value.get("filesystem_profile")
        )
        if security.get("cap_drop") != ["ALL"]:
            raise CandidateCatalogError(
                f"{role} capability drop policy must be exactly [ALL]"
            )
        if resources.get("memory_swap_bytes") != resources.get("memory_bytes"):
            raise CandidateCatalogError(
                f"{role} memory swap must equal its memory limit"
            )
        mounts = filesystem.get("writable_mounts")
        if not isinstance(mounts, list):
            raise CandidateCatalogError(f"{role} writable mounts are malformed")
        mount_keys: list[tuple[str, str]] = []
        for mount_value in mounts:
            mount = _required_mapping(mount_value, f"{role} writable mount")
            mount_keys.append(
                (
                    _required_string(
                        mount.get("destination"), f"{role} mount destination"
                    ),
                    _required_string(mount.get("type"), f"{role} mount type"),
                )
            )
        destinations = [destination for destination, _mount_type in mount_keys]
        if len(set(destinations)) != len(destinations):
            raise CandidateCatalogError(
                f"{role} filesystem profile contains duplicate writable destinations"
            )
        if mount_keys != sorted(mount_keys):
            raise CandidateCatalogError(
                f"{role} filesystem profile mounts are not in canonical order"
            )

    worker_filesystem = _required_mapping(
        worker.get("filesystem_profile"), "worker filesystem profile"
    )
    evaluator_filesystem = _required_mapping(
        evaluator.get("filesystem_profile"), "evaluator filesystem profile"
    )
    if (
        worker_filesystem.get("profile_id")
        == evaluator_filesystem.get("profile_id")
        or worker_filesystem.get("profile_sha256")
        == evaluator_filesystem.get("profile_sha256")
    ):
        raise CandidateCatalogError(
            "Worker and Evaluator filesystem profiles are not independent"
        )

    identity = dict(value)
    identity.pop("candidate_id", None)
    identity.pop("candidate_sha256", None)
    identity.pop("created_at", None)
    expected_candidate_id = f"{_CANDIDATE_ID_PREFIX}-{_canonical_sha256(identity)}"
    if value.get("candidate_id") != expected_candidate_id:
        raise CandidateCatalogError(
            "candidate ID does not match canonical environment identity"
        )


def _role_policy(role_value: Mapping[str, object]) -> RoleLaunchPolicy:
    role = _required_string(role_value.get("role"), "candidate role")
    if role not in {"worker", "evaluator"}:
        raise CandidateCatalogError("candidate role is unsupported")
    image = _required_mapping(role_value.get("image"), f"{role} image")
    runtime_user = _required_mapping(
        role_value.get("runtime_user"), f"{role} runtime user"
    )
    resources = _required_mapping(
        role_value.get("resource_profile"), f"{role} resource profile"
    )
    filesystem = _required_mapping(
        role_value.get("filesystem_profile"), f"{role} filesystem profile"
    )
    mounts_value = filesystem.get("writable_mounts")
    if not isinstance(mounts_value, list):
        raise CandidateCatalogError(f"{role} writable mounts are malformed")
    managed_volumes: list[ManagedVolumePolicy] = []
    tmpfs: list[TmpfsPolicy] = []
    for mount_value in mounts_value:
        mount = _required_mapping(mount_value, f"{role} writable mount")
        mount_type = _required_string(mount.get("type"), f"{role} mount type")
        destination = _required_string(
            mount.get("destination"), f"{role} mount destination"
        )
        if mount_type == "volume":
            try:
                key = _VOLUME_KEYS[destination]
            except KeyError as error:
                raise CandidateCatalogError(
                    f"{role} volume destination is outside Controller policy"
                ) from error
            managed_volumes.append(ManagedVolumePolicy(key, destination))
        elif mount_type == "tmpfs":
            try:
                options = FACTORY_TMPFS_OPTIONS[destination]
            except KeyError as error:
                raise CandidateCatalogError(
                    f"{role} tmpfs destination is outside Controller policy"
                ) from error
            tmpfs.append(TmpfsPolicy(destination, options))
        else:
            raise CandidateCatalogError(f"{role} mount type is unsupported")
    uid = _required_int(runtime_user.get("uid"), f"{role} UID")
    gid = _required_int(runtime_user.get("gid"), f"{role} GID")
    return RoleLaunchPolicy(
        image_id=_required_string(image.get("local_image_id"), f"{role} image ID"),
        provenance_sha256=_required_string(
            image.get("provenance_sha256"), f"{role} provenance SHA-256"
        ),
        command=FACTORY_ROLE_COMMAND,
        user=f"{uid}:{gid}",
        nano_cpus=_required_int(resources.get("nano_cpus"), f"{role} nano CPUs"),
        memory_bytes=_required_int(
            resources.get("memory_bytes"), f"{role} memory"
        ),
        memory_swap_bytes=_required_int(
            resources.get("memory_swap_bytes"), f"{role} memory swap"
        ),
        pids_limit=_required_int(resources.get("pids_limit"), f"{role} PID limit"),
        timeout_seconds=_required_int(
            resources.get("timeout_seconds"), f"{role} timeout"
        ),
        managed_volumes=tuple(managed_volumes),
        tmpfs=tuple(tmpfs),
        allowed_image_environment_names=FACTORY_IMAGE_ENVIRONMENT_ALLOWLIST,
    )


@dataclass(frozen=True)
class TrustedCandidate:
    candidate_id: str
    candidate_sha256: str
    instance_id: str
    base_commit: str
    probe_sha256: str
    sanitizer_sha256: str
    definition: CandidateLaunchDefinition


class TrustedCandidateCatalog:
    def __init__(self, candidates: Mapping[str, TrustedCandidate]) -> None:
        if not candidates:
            raise CandidateCatalogError("trusted candidate catalog is empty")
        self._candidates = MappingProxyType(dict(candidates))
        self.resolver = TrustedCandidateResolver(
            {
                candidate_id: candidate.definition
                for candidate_id, candidate in candidates.items()
            }
        )

    @classmethod
    def load(
        cls,
        candidate_directory: Path,
        schema_path: Path,
        *,
        read_only_check: Callable[[Path], bool] = _filesystem_is_read_only,
    ) -> TrustedCandidateCatalog:
        if not candidate_directory.is_absolute() or not schema_path.is_absolute():
            raise CandidateCatalogError("candidate and schema paths must be absolute")
        if candidate_directory.is_symlink() or not candidate_directory.is_dir():
            raise CandidateCatalogError("candidate directory must be a real directory")
        if not read_only_check(candidate_directory):
            raise CandidateCatalogError("candidate directory is not mounted read-only")
        try:
            schema_value = _read_strict_json(schema_path)
        except CandidateCatalogError as error:
            raise CandidateCatalogError("candidate schema could not be loaded") from error
        if not isinstance(schema_value, dict):
            raise CandidateCatalogError("candidate schema root is malformed")
        Draft202012Validator.check_schema(schema_value)
        validator = Draft202012Validator(schema_value)
        try:
            entries = sorted(candidate_directory.iterdir(), key=lambda value: value.name)
        except OSError as error:
            raise CandidateCatalogError("candidate directory cannot be enumerated") from error
        if not entries:
            raise CandidateCatalogError("trusted candidate catalog is empty")
        candidates: dict[str, TrustedCandidate] = {}
        for path in entries:
            if path.is_symlink() or not path.is_file() or path.suffix != ".json":
                raise CandidateCatalogError(
                    "candidate directory contains a non-regular JSON entry"
                )
            value = _read_strict_json(path)
            if not isinstance(value, dict):
                raise CandidateCatalogError("candidate root is malformed")
            errors = sorted(
                validator.iter_errors(value),
                key=lambda item: tuple(str(part) for part in item.absolute_path),
            )
            if errors:
                raise CandidateCatalogError("candidate does not satisfy the v1 schema")
            actual_hash = value.get("candidate_sha256")
            unsigned = dict(value)
            unsigned.pop("candidate_sha256", None)
            if actual_hash != _canonical_sha256(unsigned):
                raise CandidateCatalogError(
                    "candidate SHA-256 does not match canonical content"
                )
            _verify_candidate_semantics(value)
            candidate_id = _required_string(value.get("candidate_id"), "candidate ID")
            instance_id = _required_string(value.get("instance_id"), "candidate instance")
            roles = _required_mapping(value.get("roles"), "candidate roles")
            worker_value = _required_mapping(roles.get("worker"), "worker candidate")
            evaluator_value = _required_mapping(
                roles.get("evaluator"), "evaluator candidate"
            )
            if candidate_id in candidates:
                raise CandidateCatalogError("candidate ID is duplicated")
            candidate_sha256 = _required_string(actual_hash, "candidate SHA-256")
            base_commit = _required_string(
                value.get("base_commit"), "candidate base commit"
            )
            probe_sha256 = _required_string(
                value.get("probe_sha256"), "candidate probe SHA-256"
            )
            sanitizer_sha256 = _required_string(
                value.get("sanitizer_sha256"), "candidate sanitizer SHA-256"
            )
            definition = CandidateLaunchDefinition(
                candidate_sha256=candidate_sha256,
                instance_id=instance_id,
                base_commit=base_commit,
                probe_sha256=probe_sha256,
                worker=_role_policy(worker_value),
                evaluator=_role_policy(evaluator_value),
            )
            candidates[candidate_id] = TrustedCandidate(
                candidate_id=candidate_id,
                candidate_sha256=candidate_sha256,
                instance_id=instance_id,
                base_commit=base_commit,
                probe_sha256=probe_sha256,
                sanitizer_sha256=sanitizer_sha256,
                definition=definition,
            )
        return cls(candidates)

    def candidate(self, candidate_id: str) -> TrustedCandidate:
        try:
            return self._candidates[candidate_id]
        except KeyError as error:
            raise FactoryOperationRejected("candidate is not registered") from error

    @property
    def candidates(self) -> Mapping[str, TrustedCandidate]:
        return self._candidates


def _image_environment_names(image: object) -> tuple[str, ...]:
    attrs = getattr(image, "attrs", None)
    if not isinstance(attrs, Mapping):
        raise CandidateCatalogError("candidate image inspect envelope is unavailable")
    config = attrs.get("Config")
    if not isinstance(config, Mapping):
        raise CandidateCatalogError("candidate image Config is unavailable")
    environment_value = config.get("Env")
    if environment_value is None:
        return ()
    if not isinstance(environment_value, list):
        raise CandidateCatalogError("candidate image Config.Env is malformed")
    names: list[str] = []
    for entry in environment_value:
        if not isinstance(entry, str) or "=" not in entry:
            raise CandidateCatalogError("candidate image environment entry is malformed")
        name = entry.split("=", 1)[0]
        if _ENVIRONMENT_NAME.fullmatch(name) is None or name in names:
            raise CandidateCatalogError("candidate image environment names are malformed")
        names.append(name)
    return tuple(names)


def validate_candidate_images(
    client: DockerClientProtocol,
    catalog: TrustedCandidateCatalog,
) -> None:
    inspected: set[tuple[str, str, str, str, str, str]] = set()
    allowlist = frozenset(FACTORY_IMAGE_ENVIRONMENT_ALLOWLIST)
    for candidate in catalog.candidates.values():
        for role, policy in (
            ("worker", candidate.definition.worker),
            ("evaluator", candidate.definition.evaluator),
        ):
            key = (
                policy.image_id,
                policy.provenance_sha256,
                candidate.probe_sha256,
                candidate.sanitizer_sha256,
                candidate.instance_id,
                candidate.base_commit,
            )
            if key in inspected:
                continue
            inspected.add(key)
            try:
                image = client.images.get(policy.image_id)
            except Exception as error:
                raise CandidateCatalogError(
                    f"{role} candidate image is not locally inspectable"
                ) from error
            attrs = getattr(image, "attrs", None)
            image_object_id = getattr(image, "id", None)
            if not isinstance(attrs, Mapping):
                raise CandidateCatalogError(f"{role} candidate image inspect is malformed")
            image_id = attrs.get("Id")
            platform = f"{attrs.get('Os')}/{attrs.get('Architecture')}"
            config = attrs.get("Config")
            labels = config.get("Labels") if isinstance(config, Mapping) else None
            provenance = (
                labels.get(IMAGE_PROVENANCE_LABEL)
                if isinstance(labels, Mapping)
                else None
            )
            expected_labels = {
                IMAGE_ROLE_PROBE_LABEL: candidate.probe_sha256,
                IMAGE_SANITIZER_LABEL: candidate.sanitizer_sha256,
                IMAGE_INSTANCE_LABEL: candidate.instance_id,
                IMAGE_BASE_COMMIT_LABEL: candidate.base_commit,
            }
            if (
                image_id != policy.image_id
                or image_object_id != policy.image_id
                or _IMAGE_ID.fullmatch(policy.image_id) is None
                or platform != "linux/amd64"
                or provenance != policy.provenance_sha256
                or not isinstance(labels, Mapping)
                or any(
                    labels.get(name) != expected
                    for name, expected in expected_labels.items()
                )
            ):
                raise CandidateCatalogError(
                    f"{role} candidate image identity, provenance, or task binding drifted"
                )
            environment_names = _image_environment_names(image)
            if any(name in _SENSITIVE_ENVIRONMENT_NAMES for name in environment_names):
                raise CandidateCatalogError(
                    f"{role} candidate image contains a sensitive environment name"
                )
            unexpected = sorted(set(environment_names) - allowlist)
            if unexpected:
                raise CandidateCatalogError(
                    f"{role} candidate image environment is outside Controller policy"
                )


@dataclass(frozen=True)
class FactoryHttpRequest:
    operation_id: str
    candidate_id: str
    instance_id: str

    def to_dict(self) -> dict[str, str]:
        return {
            "operation_id": self.operation_id,
            "candidate_id": self.candidate_id,
            "instance_id": self.instance_id,
        }

    @property
    def sha256(self) -> str:
        return _canonical_sha256(self.to_dict())


@dataclass(frozen=True)
class OperationJournalRecord:
    event: str
    sequence: int
    operation_id: str
    candidate_id: str
    candidate_sha256: str
    instance_id: str
    request_sha256: str
    http_request_sha256: str
    at: str
    report_sha256: str | None
    previous_record_sha256: str | None
    record_sha256: str

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": "v1",
            "record_type": "factory_operation_event",
            "event": self.event,
            "sequence": self.sequence,
            "operation_id": self.operation_id,
            "candidate_id": self.candidate_id,
            "candidate_sha256": self.candidate_sha256,
            "instance_id": self.instance_id,
            "request_sha256": self.request_sha256,
            "http_request_sha256": self.http_request_sha256,
            "at": self.at,
            "report_sha256": self.report_sha256,
            "previous_record_sha256": self.previous_record_sha256,
            "record_sha256": self.record_sha256,
        }


@dataclass(frozen=True)
class PersistedOperation:
    request: FactoryHttpRequest
    candidate_sha256: str
    request_sha256: str
    accepted_at: str
    last_record: OperationJournalRecord
    report: dict[str, object] | None


def _operation_directory_name(operation_id: str) -> str:
    return hashlib.sha256(operation_id.encode("utf-8")).hexdigest()


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_all(descriptor: int, value: bytes) -> None:
    offset = 0
    while offset < len(value):
        written = os.write(descriptor, value[offset:])
        if written < 1:
            raise OSError("short append-only journal write")
        offset += written


class FactoryOperationJournal:
    def __init__(self, root: Path) -> None:
        if not root.is_absolute():
            raise FactoryRecoveryError("factory operation root must be absolute")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.is_symlink() or not root.is_dir():
            raise FactoryRecoveryError("factory operation root is not a real directory")
        self.root = root
        lock_path = root / ".owner.lock"
        self._lease = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self._lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(self._lease)
            raise FactoryRecoveryError("another factory operation owner is active") from error
        self._last_records: dict[str, OperationJournalRecord] = {}

    def close(self) -> None:
        if self._lease < 0:
            return
        try:
            fcntl.flock(self._lease, fcntl.LOCK_UN)
        finally:
            os.close(self._lease)
            self._lease = -1

    def _operation_path(self, operation_id: str) -> Path:
        return self.root / _operation_directory_name(operation_id)

    def _append(
        self,
        request: FactoryHttpRequest,
        *,
        candidate_sha256: str,
        request_sha256: str,
        event: str,
        at: str,
        report_sha256: str | None,
    ) -> OperationJournalRecord:
        previous = self._last_records.get(request.operation_id)
        sequence = 0 if previous is None else previous.sequence + 1
        unsigned: dict[str, object] = {
            "schema_version": "v1",
            "record_type": "factory_operation_event",
            "event": event,
            "sequence": sequence,
            "operation_id": request.operation_id,
            "candidate_id": request.candidate_id,
            "candidate_sha256": candidate_sha256,
            "instance_id": request.instance_id,
            "request_sha256": request_sha256,
            "http_request_sha256": request.sha256,
            "at": at,
            "report_sha256": report_sha256,
            "previous_record_sha256": previous.record_sha256 if previous else None,
        }
        record = OperationJournalRecord(
            event=event,
            sequence=sequence,
            operation_id=request.operation_id,
            candidate_id=request.candidate_id,
            candidate_sha256=candidate_sha256,
            instance_id=request.instance_id,
            request_sha256=request_sha256,
            http_request_sha256=request.sha256,
            at=at,
            report_sha256=report_sha256,
            previous_record_sha256=previous.record_sha256 if previous else None,
            record_sha256=_canonical_sha256(unsigned),
        )
        operation_path = self._operation_path(request.operation_id)
        operation_path.mkdir(mode=0o700, exist_ok=previous is not None)
        if previous is None:
            _fsync_directory(self.root)
        journal_path = operation_path / "journal.jsonl"
        descriptor = os.open(
            journal_path,
            os.O_APPEND | os.O_CREAT | os.O_WRONLY,
            0o600,
        )
        try:
            _write_all(descriptor, _canonical_bytes(record.to_dict()))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _fsync_directory(operation_path)
        self._last_records[request.operation_id] = record
        return record

    def begin(
        self,
        request: FactoryHttpRequest,
        resolved: ResolvedProbeRequest,
        *,
        accepted_at: str,
    ) -> OperationJournalRecord:
        if request.operation_id in self._last_records:
            raise FactoryRecoveryError("operation journal already exists")
        return self._append(
            request,
            candidate_sha256=resolved.candidate_sha256,
            request_sha256=resolved.request_sha256,
            event="accepted",
            at=accepted_at,
            report_sha256=None,
        )

    def finish(
        self,
        request: FactoryHttpRequest,
        resolved: ResolvedProbeRequest,
        report: Mapping[str, object],
        *,
        event: str,
        finished_at: str,
    ) -> OperationJournalRecord:
        if event not in {"completed", "recovered_interrupted"}:
            raise FactoryRecoveryError("terminal journal event is unsupported")
        report_sha256 = report.get("report_sha256")
        if not isinstance(report_sha256, str) or _SHA256.fullmatch(report_sha256) is None:
            raise FactoryRecoveryError("terminal report SHA-256 is malformed")
        self._write_report_once(request.operation_id, report)
        return self._append(
            request,
            candidate_sha256=resolved.candidate_sha256,
            request_sha256=resolved.request_sha256,
            event=event,
            at=finished_at,
            report_sha256=report_sha256,
        )

    def record_existing_terminal(
        self,
        request: FactoryHttpRequest,
        resolved: ResolvedProbeRequest,
        report: Mapping[str, object],
        *,
        finished_at: str,
    ) -> OperationJournalRecord:
        report_sha256 = report.get("report_sha256")
        if not isinstance(report_sha256, str) or _SHA256.fullmatch(report_sha256) is None:
            raise FactoryRecoveryError("terminal report SHA-256 is malformed")
        report_path = self._operation_path(request.operation_id) / "report.json"
        if not report_path.is_file():
            raise FactoryRecoveryError("existing terminal report is unavailable")
        return self._append(
            request,
            candidate_sha256=resolved.candidate_sha256,
            request_sha256=resolved.request_sha256,
            event="completed",
            at=finished_at,
            report_sha256=report_sha256,
        )

    def _write_report_once(
        self,
        operation_id: str,
        report: Mapping[str, object],
    ) -> None:
        operation_path = self._operation_path(operation_id)
        report_path = operation_path / "report.json"
        if report_path.exists():
            raise FactoryRecoveryError("terminal report is immutable")
        temporary_path = operation_path / f".report-{os.getpid()}-{id(report)}.tmp"
        descriptor = os.open(
            temporary_path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
        try:
            _write_all(descriptor, _canonical_bytes(report))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary_path, report_path)
        _fsync_directory(operation_path)

    def load(self) -> tuple[PersistedOperation, ...]:
        operations: list[PersistedOperation] = []
        for operation_path in sorted(self.root.iterdir(), key=lambda value: value.name):
            if operation_path.name == ".owner.lock":
                continue
            if (
                operation_path.is_symlink()
                or not operation_path.is_dir()
                or _SHA256.fullmatch(operation_path.name) is None
            ):
                raise FactoryRecoveryError("operation root contains an unknown entry")
            journal_path = operation_path / "journal.jsonl"
            try:
                lines = journal_path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeError) as error:
                raise FactoryRecoveryError("operation journal is unreadable") from error
            if not lines:
                raise FactoryRecoveryError("operation journal is empty")
            records = [self._parse_record(line) for line in lines]
            accepted = records[0]
            if accepted.event != "accepted" or accepted.sequence != 0:
                raise FactoryRecoveryError("operation journal does not start with accepted")
            for index, record in enumerate(records):
                if record.sequence != index:
                    raise FactoryRecoveryError("operation journal sequence is not contiguous")
                if index == 0:
                    if record.previous_record_sha256 is not None:
                        raise FactoryRecoveryError("first operation journal record has a predecessor")
                elif record.previous_record_sha256 != records[index - 1].record_sha256:
                    raise FactoryRecoveryError("operation journal hash chain is broken")
                if (
                    record.operation_id != accepted.operation_id
                    or record.candidate_id != accepted.candidate_id
                    or record.candidate_sha256 != accepted.candidate_sha256
                    or record.instance_id != accepted.instance_id
                    or record.request_sha256 != accepted.request_sha256
                    or record.http_request_sha256 != accepted.http_request_sha256
                ):
                    raise FactoryRecoveryError("operation journal request binding drifted")
            if len(records) > 2 or (
                len(records) == 2
                and records[1].event not in {"completed", "recovered_interrupted"}
            ):
                raise FactoryRecoveryError("operation journal event order is invalid")
            request = FactoryHttpRequest(
                accepted.operation_id,
                accepted.candidate_id,
                accepted.instance_id,
            )
            if request.sha256 != accepted.http_request_sha256:
                raise FactoryRecoveryError("operation HTTP request hash drifted")
            if operation_path.name != _operation_directory_name(request.operation_id):
                raise FactoryRecoveryError("operation directory binding drifted")
            report_path = operation_path / "report.json"
            report: dict[str, object] | None = None
            if report_path.exists():
                report_value = _read_persisted_json(report_path)
                if not isinstance(report_value, dict):
                    raise FactoryRecoveryError("terminal report root is malformed")
                report = report_value
            terminal = records[-1] if len(records) == 2 else None
            if terminal is not None and report is None:
                raise FactoryRecoveryError("terminal journal record has no report")
            if terminal is not None and report is not None:
                if terminal.report_sha256 != report.get("report_sha256"):
                    raise FactoryRecoveryError("terminal journal and report hashes differ")
            self._last_records[request.operation_id] = records[-1]
            operations.append(
                PersistedOperation(
                    request=request,
                    candidate_sha256=accepted.candidate_sha256,
                    request_sha256=accepted.request_sha256,
                    accepted_at=accepted.at,
                    last_record=records[-1],
                    report=report,
                )
            )
        return tuple(operations)

    @staticmethod
    def _parse_record(line: str) -> OperationJournalRecord:
        if not line or len(line.encode("utf-8")) > 64 * 1024:
            raise FactoryRecoveryError("operation journal record size is invalid")
        try:
            value = json.loads(
                line,
                object_pairs_hook=_unique_json_object,
                parse_constant=_reject_json_constant,
            )
        except (CandidateCatalogError, json.JSONDecodeError) as error:
            raise FactoryRecoveryError("operation journal record is not strict JSON") from error
        if not isinstance(value, dict) or set(value) != _JOURNAL_KEYS:
            raise FactoryRecoveryError("operation journal record envelope is not exact")
        unsigned = dict(value)
        actual_hash = unsigned.pop("record_sha256")
        if actual_hash != _canonical_sha256(unsigned):
            raise FactoryRecoveryError("operation journal record hash is invalid")
        event = value.get("event")
        sequence = value.get("sequence")
        operation_id = value.get("operation_id")
        candidate_id = value.get("candidate_id")
        candidate_sha256 = value.get("candidate_sha256")
        instance_id = value.get("instance_id")
        request_sha256 = value.get("request_sha256")
        http_request_sha256 = value.get("http_request_sha256")
        at = value.get("at")
        report_sha256 = value.get("report_sha256")
        previous = value.get("previous_record_sha256")
        if (
            value.get("schema_version") != "v1"
            or value.get("record_type") != "factory_operation_event"
            or event not in {"accepted", "completed", "recovered_interrupted"}
            or isinstance(sequence, bool)
            or not isinstance(sequence, int)
            or sequence < 0
            or not isinstance(operation_id, str)
            or _OPERATION_ID.fullmatch(operation_id) is None
            or not isinstance(candidate_id, str)
            or not candidate_id
            or len(candidate_id) > 160
            or not isinstance(candidate_sha256, str)
            or _SHA256.fullmatch(candidate_sha256) is None
            or instance_id != AXIOS_SMOKE_INSTANCE_ID
            or not isinstance(request_sha256, str)
            or _SHA256.fullmatch(request_sha256) is None
            or not isinstance(http_request_sha256, str)
            or _SHA256.fullmatch(http_request_sha256) is None
            or not isinstance(at, str)
            or not at
            or (
                report_sha256 is not None
                and (
                    not isinstance(report_sha256, str)
                    or _SHA256.fullmatch(report_sha256) is None
                )
            )
            or (
                previous is not None
                and (not isinstance(previous, str) or _SHA256.fullmatch(previous) is None)
            )
            or not isinstance(actual_hash, str)
        ):
            raise FactoryRecoveryError("operation journal record fields are malformed")
        if (event == "accepted") != (report_sha256 is None):
            raise FactoryRecoveryError("operation journal terminal hash is inconsistent")
        return OperationJournalRecord(
            event,
            sequence,
            operation_id,
            candidate_id,
            candidate_sha256,
            instance_id,
            request_sha256,
            http_request_sha256,
            at,
            report_sha256,
            previous,
            actual_hash,
        )


def _read_persisted_json(path: Path) -> object:
    try:
        content = path.read_text(encoding="utf-8")
        return json.loads(
            content,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except (OSError, UnicodeError, json.JSONDecodeError, CandidateCatalogError) as error:
        raise FactoryRecoveryError("persisted JSON is invalid") from error


def _sanitize_report(
    payload: Mapping[str, object],
    controller_execution: ControllerExecutionEvidence,
) -> dict[str, object]:
    sanitized = json.loads(json.dumps(payload))
    if not isinstance(sanitized, dict):
        raise FactoryRecoveryError("factory report root is malformed")
    roles_value = sanitized.get("roles")
    if not isinstance(roles_value, dict):
        raise FactoryRecoveryError("factory report roles are malformed")
    for role in ("worker", "evaluator"):
        evidence = roles_value.get(role)
        if not isinstance(evidence, dict):
            raise FactoryRecoveryError("factory role evidence is malformed")
        active = evidence.get("active_probe")
        if isinstance(active, dict) and active.get("errors"):
            active["errors"] = [f"{role}:active_probe:failed"]
        cleanup = evidence.get("cleanup")
        if isinstance(cleanup, dict) and cleanup.get("errors"):
            cleanup["errors"] = [f"{role}:cleanup:failed"]
        if evidence.get("errors"):
            phase = evidence.get("failure_phase")
            rendered_phase = phase if isinstance(phase, str) else "unknown"
            evidence["errors"] = [f"{role}:{rendered_phase}:failed"]
        unsigned_evidence = dict(evidence)
        unsigned_evidence.pop("evidence_sha256", None)
        evidence["evidence_sha256"] = _canonical_sha256(unsigned_evidence)
    if sanitized.get("errors"):
        sanitized["errors"] = ["factory:failed"]
    sanitized["controller_execution"] = controller_execution.to_dict()
    unsigned_report = dict(sanitized)
    unsigned_report.pop("report_sha256", None)
    sanitized["report_sha256"] = _canonical_sha256(unsigned_report)
    return sanitized


def _validate_report(
    report: Mapping[str, object],
    resolved: ResolvedProbeRequest,
    validator: Draft202012Validator,
) -> None:
    validator.validate(report)
    unsigned_report = dict(report)
    actual_hash = unsigned_report.pop("report_sha256", None)
    if actual_hash != _canonical_sha256(unsigned_report):
        raise FactoryRecoveryError("factory report SHA-256 is invalid")
    if (
        report.get("operation_id") != resolved.operation_id
        or report.get("request_sha256") != resolved.request_sha256
        or report.get("candidate_id") != resolved.candidate_id
        or report.get("candidate_sha256") != resolved.candidate_sha256
        or report.get("probe_profile") != TASK_ROLE_FACTORY_PROBE_PROFILE
        or report.get("instance_id") != resolved.instance_id
        or report.get("base_commit") != resolved.base_commit
        or report.get("execution_order") != ["worker", "evaluator"]
    ):
        raise FactoryRecoveryError("factory report request binding drifted")
    controller_execution = report.get("controller_execution")
    if not isinstance(controller_execution, Mapping):
        raise FactoryRecoveryError("factory Controller execution evidence is malformed")
    container_hostname = controller_execution.get("container_hostname")
    container_id = controller_execution.get("container_id")
    image_id = controller_execution.get("image_id")
    compose_project = controller_execution.get("compose_project")
    if (
        not isinstance(container_hostname, str)
        or _CONTAINER_HOSTNAME.fullmatch(container_hostname) is None
        or not isinstance(container_id, str)
        or _SHA256.fullmatch(container_id) is None
        or not container_id.startswith(container_hostname)
        or not isinstance(image_id, str)
        or _IMAGE_ID.fullmatch(image_id) is None
        or not isinstance(compose_project, str)
        or controller_execution.get("compose_service") != "controller"
        or not isinstance(controller_execution.get("compose_config_sha256"), str)
        or _SHA256.fullmatch(str(controller_execution["compose_config_sha256"]))
        is None
        or controller_execution.get("read_only_root_filesystem") is not True
        or controller_execution.get("cap_drop") != ["ALL"]
        or controller_execution.get("security_opt")
        != ["no-new-privileges:true"]
        or controller_execution.get("published_ports") != []
    ):
        raise FactoryRecoveryError(
            "factory Controller execution identity or safety policy drifted"
        )
    networks = controller_execution.get("networks")
    if not isinstance(networks, list) or len(networks) != 1:
        raise FactoryRecoveryError(
            "factory Controller execution network is not unique"
        )
    network = networks[0]
    if (
        not isinstance(network, Mapping)
        or network.get("compose_project") != compose_project
        or network.get("compose_network") != "repofix-control"
        or network.get("internal") is not True
    ):
        raise FactoryRecoveryError(
            "factory Controller execution network is not the internal control network"
        )
    mounts = controller_execution.get("mounts")
    if not isinstance(mounts, list) or len(mounts) != 4:
        raise FactoryRecoveryError("factory Controller execution mounts are malformed")
    actual_mounts: list[tuple[object, object, object, object]] = []
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise FactoryRecoveryError(
                "factory Controller execution mount is malformed"
            )
        actual_mounts.append(
            (
                mount.get("type"),
                mount.get("source"),
                mount.get("destination"),
                mount.get("read_write"),
            )
        )
    if not controller_mount_signatures_match_exact_allowlist(
        actual_mounts, compose_project
    ):
        raise FactoryRecoveryError(
            "factory Controller execution mounts are outside the exact allowlist"
        )
    roles = report.get("roles")
    if not isinstance(roles, Mapping):
        raise FactoryRecoveryError("factory report roles are malformed")
    for role in ("worker", "evaluator"):
        evidence = roles.get(role)
        if not isinstance(evidence, Mapping):
            raise FactoryRecoveryError("factory role evidence is malformed")
        unsigned_evidence = dict(evidence)
        evidence_hash = unsigned_evidence.pop("evidence_sha256", None)
        if evidence_hash != _canonical_sha256(unsigned_evidence):
            raise FactoryRecoveryError("factory role evidence SHA-256 is invalid")


@dataclass(frozen=True)
class FactoryOperationResult:
    report: dict[str, object]
    replayed: bool


@dataclass
class _OperationState:
    request_sha256: str
    event: Event
    report: dict[str, object] | None = None
    unavailable: bool = False


class FactoryOperationService:
    def __init__(
        self,
        client: DockerClientProtocol,
        catalog: TrustedCandidateCatalog,
        operation_root: Path,
        report_schema_path: Path,
        *,
        clock: Callable[[], str] = _now,
        factory: RoleContainerFactory | None = None,
        controller_execution: ControllerExecutionEvidence | None = None,
        controller_hostname: str | None = None,
        compose_project: str = "repofixlab",
    ) -> None:
        report_schema = _read_persisted_json(report_schema_path)
        if not isinstance(report_schema, dict):
            raise FactoryRecoveryError("factory report schema root is malformed")
        Draft202012Validator.check_schema(report_schema)
        self._report_validator = Draft202012Validator(report_schema)
        self._client = client
        self.catalog = catalog
        self._clock = clock
        self._controller_execution = controller_execution or inspect_controller_execution(
            client,
            container_hostname=controller_hostname or os.uname().nodename,
            compose_project=compose_project,
        )
        self._factory = factory or RoleContainerFactory(
            client,
            catalog.resolver,
            controller_execution=self._controller_execution,
        )
        self._journal = FactoryOperationJournal(operation_root)
        self._lock = Lock()
        self._capacity = BoundedSemaphore(1)
        self._operations: dict[str, _OperationState] = {}
        self._recovery_blocked = False
        try:
            self._recover()
            validate_candidate_images(client, catalog)
        except Exception:
            self._journal.close()
            raise

    def close(self) -> None:
        self._journal.close()

    def _resolve(self, request: FactoryHttpRequest) -> ResolvedProbeRequest:
        if _OPERATION_ID.fullmatch(request.operation_id) is None:
            raise FactoryOperationRejected("operation ID is malformed")
        candidate = self.catalog.candidate(request.candidate_id)
        if request.instance_id != candidate.instance_id:
            raise FactoryOperationRejected("candidate instance does not match")
        request_sha256 = task_role_factory_probe_request_sha256(
            operation_id=request.operation_id,
            candidate_id=request.candidate_id,
            candidate_sha256=candidate.candidate_sha256,
        )
        return self.catalog.resolver.resolve_request(
            operation_id=request.operation_id,
            candidate_id=request.candidate_id,
            candidate_sha256=candidate.candidate_sha256,
            request_sha256=request_sha256,
        )

    def _recover(self) -> None:
        for persisted in self._journal.load():
            resolved = self._resolve(persisted.request)
            if (
                resolved.candidate_sha256 != persisted.candidate_sha256
                or resolved.request_sha256 != persisted.request_sha256
            ):
                raise FactoryRecoveryError(
                    "persisted operation no longer binds the trusted candidate"
                )
            if persisted.report is not None:
                _validate_report(
                    persisted.report,
                    resolved,
                    self._report_validator,
                )
                if persisted.last_record.event == "accepted":
                    finished_at = persisted.report.get("finished_at")
                    if not isinstance(finished_at, str) or not finished_at:
                        raise FactoryRecoveryError(
                            "persisted terminal report timestamp is malformed"
                        )
                    self._journal.record_existing_terminal(
                        persisted.request,
                        resolved,
                        persisted.report,
                        finished_at=finished_at,
                    )
                self._operations[persisted.request.operation_id] = _OperationState(
                    persisted.request.sha256,
                    Event(),
                    dict(persisted.report),
                )
                self._operations[persisted.request.operation_id].event.set()
                continue
            recovered = self._factory.recover_interrupted_probe(
                resolved,
                started_at=persisted.accepted_at,
                finished_at=self._clock(),
            )
            report = _sanitize_report(recovered.to_dict(), self._controller_execution)
            _validate_report(report, resolved, self._report_validator)
            self._journal.finish(
                persisted.request,
                resolved,
                report,
                event="recovered_interrupted",
                finished_at=str(report["finished_at"]),
            )
            roles = report["roles"]
            assert isinstance(roles, dict)
            cleanup_blocked = False
            for role in ("worker", "evaluator"):
                evidence = roles[role]
                assert isinstance(evidence, dict)
                cleanup = evidence["cleanup"]
                assert isinstance(cleanup, dict)
                cleanup_blocked = cleanup_blocked or bool(
                    cleanup["errors"]
                    or cleanup["residual_container_ids"]
                    or cleanup["residual_volume_names"]
                )
            self._recovery_blocked = self._recovery_blocked or cleanup_blocked
            state = _OperationState(persisted.request.sha256, Event(), report)
            state.event.set()
            self._operations[persisted.request.operation_id] = state

    def execute(self, request: FactoryHttpRequest) -> FactoryOperationResult:
        resolved = self._resolve(request)
        wait_for: Event | None = None
        with self._lock:
            existing = self._operations.get(request.operation_id)
            if existing is not None:
                if existing.request_sha256 != request.sha256:
                    raise FactoryOperationConflict(
                        "operation ID conflicts with an existing request"
                    )
                if existing.report is not None:
                    return FactoryOperationResult(dict(existing.report), True)
                if existing.unavailable:
                    raise FactoryServiceUnavailable(
                        "factory operation has no recoverable terminal report"
                    )
                wait_for = existing.event
            else:
                if self._recovery_blocked:
                    raise FactoryServiceUnavailable(
                        "factory recovery left residual resources"
                    )
                if not self._capacity.acquire(blocking=False):
                    raise FactoryCapacityBusy("factory capacity is busy")
                accepted_at = self._clock()
                state = _OperationState(request.sha256, Event())
                try:
                    self._journal.begin(
                        request,
                        resolved,
                        accepted_at=accepted_at,
                    )
                except Exception:
                    self._capacity.release()
                    raise
                self._operations[request.operation_id] = state
        if wait_for is not None:
            wait_for.wait()
            with self._lock:
                state = self._operations[request.operation_id]
                if state.report is not None:
                    return FactoryOperationResult(dict(state.report), True)
                raise FactoryServiceUnavailable(
                    "factory operation has no recoverable terminal report"
                )

        state = self._operations[request.operation_id]
        try:
            try:
                raw_report = self._factory.execute_probe(resolved)
            except Exception:
                raw_report = self._factory.interrupted_probe_report(
                    resolved,
                    started_at=accepted_at,
                    finished_at=self._clock(),
                    error="factory execution terminated without a strict report",
                )
            report = _sanitize_report(raw_report.to_dict(), self._controller_execution)
            _validate_report(report, resolved, self._report_validator)
            self._journal.finish(
                request,
                resolved,
                report,
                event="completed",
                finished_at=str(report["finished_at"]),
            )
            with self._lock:
                state.report = report
            return FactoryOperationResult(dict(report), False)
        except Exception:
            with self._lock:
                state.unavailable = True
            raise FactoryServiceUnavailable(
                "factory operation could not persist a strict terminal report"
            )
        finally:
            state.event.set()
            self._capacity.release()


def load_factory_operation_service(
    client: DockerClientProtocol,
    *,
    candidate_directory: Path,
    operation_root: Path,
    schema_directory: Path,
    read_only_check: Callable[[Path], bool] = _filesystem_is_read_only,
    controller_hostname: str | None = None,
    compose_project: str = "repofixlab",
) -> FactoryOperationService:
    catalog = TrustedCandidateCatalog.load(
        candidate_directory,
        schema_directory / "task-environment-candidate.schema.json",
        read_only_check=read_only_check,
    )
    return FactoryOperationService(
        client,
        catalog,
        operation_root,
        schema_directory / "task-role-factory-probe-report.schema.json",
        controller_hostname=controller_hostname,
        compose_project=compose_project,
    )
