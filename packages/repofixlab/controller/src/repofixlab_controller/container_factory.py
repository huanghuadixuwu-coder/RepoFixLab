from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import re
from time import monotonic_ns
from types import MappingProxyType
from typing import Callable, Literal, Mapping, Protocol
from uuid import uuid4


Role = Literal["worker", "evaluator"]
FailurePhase = Literal[
    "candidate_validation",
    "image_inspect",
    "create",
    "start",
    "active_probe",
    "runtime_inspect",
    "cleanup",
    "residual_audit",
]

TASK_ROLE_FACTORY_PROBE_PROFILE = "axios-worker-evaluator-smoke-v1"
AXIOS_SMOKE_INSTANCE_ID = "axios__axios-5892"
AXIOS_SMOKE_BASE_COMMIT = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"
IMAGE_PROVENANCE_LABEL = "io.repofixlab.provenance-sha256"
IMAGE_COMPOSE_CONFIG_LABEL = "io.repofixlab.compose-config-sha256"
CONTROLLER_DOCKER_SOCKET_SOURCES = frozenset(
    {"/var/run/docker.sock", "/run/host-services/docker.proxy.sock"}
)
_M0_MAX_NANO_CPUS = 4_000_000_000

_IMAGE_ID = re.compile(r"^sha256:[a-f0-9]{64}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")
_CONTAINER_HOSTNAME = re.compile(r"^[a-f0-9]{12,64}$")
_COMPOSE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
_HEAD_SHA = re.compile(r"^[a-f0-9]{40}$")
_INSTANCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$")
_OPERATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_MOUNT_KEY = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_USER = re.compile(r"^([0-9]+):([0-9]+)$")
_NONCE = re.compile(r"^[a-f0-9]{32}$")
_ENVIRONMENT_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
_ALLOWED_VOLUME_TARGETS: Mapping[Role, frozenset[str]] = {
    "worker": frozenset({"/testbed", "/output"}),
    "evaluator": frozenset({"/testbed", "/evaluation"}),
}
_ALLOWED_TMPFS_TARGETS = frozenset({"/tmp", "/run/repofixlab"})
_DOCKER_SOCKET_PATHS = frozenset({"/var/run/docker.sock", "/run/docker.sock"})
_SENSITIVE_ENVIRONMENT_NAMES = frozenset(
    {"ZHIPU_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DOCKER_HOST"}
)
_BOUND_ENVIRONMENT_NAMES = frozenset(
    {
        "REPOFIX_OPERATION_ID",
        "REPOFIX_CANDIDATE_ID",
        "REPOFIX_ROLE",
        "REPOFIX_ACTIVE_PROBE_NONCE",
        "REPOFIX_EXPECTED_BASE_COMMIT",
        "REPOFIX_EXPECTED_PROBE_SHA256",
    }
)
_MANAGED_LABEL = "io.repofixlab.managed"
_OPERATION_LABEL = "io.repofixlab.operation-id"
_CANDIDATE_LABEL = "io.repofixlab.candidate-id"
_ROLE_LABEL = "io.repofixlab.role"
_RESOLVER_TOKEN = object()


class ContainerFactoryError(RuntimeError):
    """A fail-closed production role-container policy or execution error."""


class ContainerProtocol(Protocol):
    id: str
    attrs: Mapping[str, object]

    def logs(self, *, stderr: bool = True, stdout: bool = True) -> bytes | str: ...

    def remove(self, *, force: bool = False) -> None: ...

    def wait(self, *, timeout: int | None = None) -> Mapping[str, object]: ...


class ContainerCollectionProtocol(Protocol):
    def get(self, container_id: str) -> ContainerProtocol: ...

    def list(
        self,
        *,
        all: bool = False,
        filters: Mapping[str, object] | None = None,
    ) -> list[ContainerProtocol]: ...

    def run(
        self,
        image: str,
        command: list[str],
        **kwargs: object,
    ) -> ContainerProtocol: ...


class ImageProtocol(Protocol):
    id: str
    attrs: Mapping[str, object]


class ImageCollectionProtocol(Protocol):
    def get(self, image_id: str) -> ImageProtocol: ...


class VolumeProtocol(Protocol):
    name: str

    def remove(self, *, force: bool = False) -> None: ...


class VolumeCollectionProtocol(Protocol):
    def create(self, *, name: str, labels: Mapping[str, str]) -> VolumeProtocol: ...

    def list(self, *, filters: Mapping[str, object]) -> list[VolumeProtocol]: ...


class NetworkProtocol(Protocol):
    attrs: Mapping[str, object]


class NetworkCollectionProtocol(Protocol):
    def get(self, network_id: str) -> NetworkProtocol: ...


class DockerClientProtocol(Protocol):
    containers: ContainerCollectionProtocol
    images: ImageCollectionProtocol
    volumes: VolumeCollectionProtocol
    networks: NetworkCollectionProtocol


@dataclass(frozen=True)
class ManagedVolumePolicy:
    key: str
    target: str


@dataclass(frozen=True)
class TmpfsPolicy:
    target: str
    options: str


@dataclass(frozen=True)
class RoleLaunchPolicy:
    image_id: str
    provenance_sha256: str
    command: tuple[str, ...]
    user: str
    nano_cpus: int
    memory_bytes: int
    memory_swap_bytes: int
    pids_limit: int
    timeout_seconds: int
    managed_volumes: tuple[ManagedVolumePolicy, ...]
    tmpfs: tuple[TmpfsPolicy, ...]
    allowed_image_environment_names: tuple[str, ...]


@dataclass(frozen=True)
class CandidateLaunchDefinition:
    candidate_sha256: str
    instance_id: str
    base_commit: str
    probe_sha256: str
    worker: RoleLaunchPolicy
    evaluator: RoleLaunchPolicy


@dataclass(frozen=True, init=False)
class ResolvedProbeRequest:
    operation_id: str
    request_sha256: str
    candidate_id: str
    candidate_sha256: str
    probe_profile: str
    instance_id: str
    base_commit: str
    probe_sha256: str
    worker: RoleLaunchPolicy
    evaluator: RoleLaunchPolicy

    def __init__(
        self,
        *,
        resolver_token: object,
        operation_id: str,
        request_sha256: str,
        candidate_id: str,
        definition: CandidateLaunchDefinition,
    ) -> None:
        if resolver_token is not _RESOLVER_TOKEN:
            raise ContainerFactoryError(
                "ResolvedProbeRequest may only be constructed by the trusted resolver"
            )
        object.__setattr__(self, "operation_id", operation_id)
        object.__setattr__(self, "request_sha256", request_sha256)
        object.__setattr__(self, "candidate_id", candidate_id)
        object.__setattr__(self, "candidate_sha256", definition.candidate_sha256)
        object.__setattr__(self, "probe_profile", TASK_ROLE_FACTORY_PROBE_PROFILE)
        object.__setattr__(self, "instance_id", definition.instance_id)
        object.__setattr__(self, "base_commit", definition.base_commit)
        object.__setattr__(self, "probe_sha256", definition.probe_sha256)
        object.__setattr__(self, "worker", definition.worker)
        object.__setattr__(self, "evaluator", definition.evaluator)


@dataclass(frozen=True, init=False)
class ResolvedRoleLaunchSpec:
    request: ResolvedProbeRequest
    role: Role
    nonce: str
    container_name: str
    policy: RoleLaunchPolicy
    expected_uid: int
    expected_gid: int
    volume_names: Mapping[str, str]
    environment: Mapping[str, str]
    allowed_environment_names: frozenset[str]
    labels: Mapping[str, str]

    def __init__(
        self,
        *,
        resolver_token: object,
        request: ResolvedProbeRequest,
        role: Role,
        nonce: str,
        container_name: str,
        policy: RoleLaunchPolicy,
        volume_names: Mapping[str, str],
        environment: Mapping[str, str],
        labels: Mapping[str, str],
    ) -> None:
        if resolver_token is not _RESOLVER_TOKEN:
            raise ContainerFactoryError(
                "ResolvedRoleLaunchSpec may only be constructed by the trusted resolver"
            )
        user_match = _USER.fullmatch(policy.user)
        if user_match is None:
            raise ContainerFactoryError("resolved role user is malformed")
        object.__setattr__(self, "request", request)
        object.__setattr__(self, "role", role)
        object.__setattr__(self, "nonce", nonce)
        object.__setattr__(self, "container_name", container_name)
        object.__setattr__(self, "policy", policy)
        object.__setattr__(self, "expected_uid", int(user_match.group(1)))
        object.__setattr__(self, "expected_gid", int(user_match.group(2)))
        object.__setattr__(self, "volume_names", MappingProxyType(dict(volume_names)))
        object.__setattr__(self, "environment", MappingProxyType(dict(environment)))
        object.__setattr__(
            self,
            "allowed_environment_names",
            frozenset(policy.allowed_image_environment_names) | _BOUND_ENVIRONMENT_NAMES,
        )
        object.__setattr__(self, "labels", MappingProxyType(dict(labels)))


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


def task_role_factory_probe_request_sha256(
    *,
    operation_id: str,
    candidate_id: str,
    candidate_sha256: str,
) -> str:
    return _canonical_sha256(
        {
            "schema_version": "v1",
            "request_type": "task_role_factory_probe",
            "operation_id": operation_id,
            "candidate_id": candidate_id,
            "candidate_sha256": candidate_sha256,
            "probe_profile": TASK_ROLE_FACTORY_PROBE_PROFILE,
        }
    )


def _validate_role_policy(role: Role, policy: RoleLaunchPolicy) -> None:
    if _IMAGE_ID.fullmatch(policy.image_id) is None:
        raise ContainerFactoryError(f"{role} image_id must be an exact sha256 image ID")
    if _SHA256.fullmatch(policy.provenance_sha256) is None:
        raise ContainerFactoryError(f"{role} provenance SHA-256 is malformed")
    if not policy.command or any(not value or "\x00" in value for value in policy.command):
        raise ContainerFactoryError(f"{role} command must contain non-empty arguments")
    user_match = _USER.fullmatch(policy.user)
    if user_match is None:
        raise ContainerFactoryError(f"{role} user must be an explicit uid:gid")
    if role == "worker" and (
        int(user_match.group(1)) < 1 or int(user_match.group(2)) < 1
    ):
        raise ContainerFactoryError("worker uid and gid must be non-root")
    if policy.nano_cpus < 1 or policy.nano_cpus > _M0_MAX_NANO_CPUS:
        raise ContainerFactoryError(f"{role} nano_cpus is outside the policy range")
    if policy.memory_bytes < 16 * 1024 * 1024:
        raise ContainerFactoryError(f"{role} memory limit is below the policy minimum")
    if policy.memory_swap_bytes != policy.memory_bytes:
        raise ContainerFactoryError(f"{role} memory_swap must equal memory")
    if policy.pids_limit < 1 or policy.pids_limit > 512:
        raise ContainerFactoryError(f"{role} pids limit is outside the policy range")
    if policy.timeout_seconds < 1 or policy.timeout_seconds > 3600:
        raise ContainerFactoryError(f"{role} timeout is outside the policy range")
    keys: set[str] = set()
    targets: set[str] = set()
    for mount in policy.managed_volumes:
        if _MOUNT_KEY.fullmatch(mount.key) is None or mount.key in keys:
            raise ContainerFactoryError(f"{role} managed volume key is invalid or duplicated")
        if mount.target not in _ALLOWED_VOLUME_TARGETS[role] or mount.target in targets:
            raise ContainerFactoryError(f"{role} managed volume target is not allowlisted")
        keys.add(mount.key)
        targets.add(mount.target)
    for mount in policy.tmpfs:
        if mount.target not in _ALLOWED_TMPFS_TARGETS or mount.target in targets:
            raise ContainerFactoryError(f"{role} tmpfs target is not allowlisted")
        if mount.options not in {
            "rw,noexec,nosuid,nodev,size=16m",
            "rw,noexec,nosuid,nodev,size=64m",
            "rw,noexec,nosuid,nodev,size=512m",
        }:
            raise ContainerFactoryError(f"{role} tmpfs options are not allowlisted")
        targets.add(mount.target)
    if not targets:
        raise ContainerFactoryError(f"{role} requires at least one writable mount")
    names = policy.allowed_image_environment_names
    if len(set(names)) != len(names):
        raise ContainerFactoryError(f"{role} image environment allowlist is duplicated")
    for name in names:
        if _ENVIRONMENT_NAME.fullmatch(name) is None or name in _SENSITIVE_ENVIRONMENT_NAMES:
            raise ContainerFactoryError(f"{role} image environment allowlist is invalid")


class TrustedCandidateResolver:
    def __init__(self, definitions: Mapping[str, CandidateLaunchDefinition]) -> None:
        if not definitions:
            raise ContainerFactoryError("candidate resolver requires a definition")
        validated: dict[str, CandidateLaunchDefinition] = {}
        for candidate_id, definition in definitions.items():
            if not candidate_id or len(candidate_id) > 160:
                raise ContainerFactoryError("candidate ID is malformed")
            if _SHA256.fullmatch(definition.candidate_sha256) is None:
                raise ContainerFactoryError("candidate SHA-256 is malformed")
            if _INSTANCE_ID.fullmatch(definition.instance_id) is None:
                raise ContainerFactoryError("candidate instance ID is malformed")
            if _HEAD_SHA.fullmatch(definition.base_commit) is None:
                raise ContainerFactoryError("candidate base commit is malformed")
            if _SHA256.fullmatch(definition.probe_sha256) is None:
                raise ContainerFactoryError("candidate probe SHA-256 is malformed")
            _validate_role_policy("worker", definition.worker)
            _validate_role_policy("evaluator", definition.evaluator)
            validated[candidate_id] = definition
        self._definitions = validated

    def resolve_request(
        self,
        *,
        operation_id: str,
        candidate_id: str,
        candidate_sha256: str,
        request_sha256: str,
    ) -> ResolvedProbeRequest:
        if _OPERATION_ID.fullmatch(operation_id) is None:
            raise ContainerFactoryError("operation ID is malformed")
        try:
            definition = self._definitions[candidate_id]
        except KeyError as error:
            raise ContainerFactoryError("candidate is not registered") from error
        if candidate_sha256 != definition.candidate_sha256:
            raise ContainerFactoryError("request candidate SHA-256 does not match")
        expected_request_sha256 = task_role_factory_probe_request_sha256(
            operation_id=operation_id,
            candidate_id=candidate_id,
            candidate_sha256=candidate_sha256,
        )
        if request_sha256 != expected_request_sha256:
            raise ContainerFactoryError("request SHA-256 does not match canonical content")
        return ResolvedProbeRequest(
            resolver_token=_RESOLVER_TOKEN,
            operation_id=operation_id,
            request_sha256=request_sha256,
            candidate_id=candidate_id,
            definition=definition,
        )

    def resolve_role(
        self,
        request: ResolvedProbeRequest,
        *,
        role: Role,
        nonce: str,
    ) -> ResolvedRoleLaunchSpec:
        if _NONCE.fullmatch(nonce) is None:
            raise ContainerFactoryError("active probe nonce is malformed")
        policy = request.worker if role == "worker" else request.evaluator
        resource_key = hashlib.sha256(
            f"{request.operation_id}\0{request.candidate_id}\0{role}\0{nonce}".encode()
        ).hexdigest()[:24]
        prefix = f"repofixlab-{role}-{resource_key}"
        volume_names = {
            mount.key: f"{prefix}-{mount.key}" for mount in policy.managed_volumes
        }
        environment = {
            "REPOFIX_OPERATION_ID": request.operation_id,
            "REPOFIX_CANDIDATE_ID": request.candidate_id,
            "REPOFIX_ROLE": role,
            "REPOFIX_ACTIVE_PROBE_NONCE": nonce,
            "REPOFIX_EXPECTED_BASE_COMMIT": request.base_commit,
            "REPOFIX_EXPECTED_PROBE_SHA256": request.probe_sha256,
        }
        labels = {
            _MANAGED_LABEL: "true",
            _OPERATION_LABEL: request.operation_id,
            _CANDIDATE_LABEL: request.candidate_id,
            _ROLE_LABEL: role,
        }
        return ResolvedRoleLaunchSpec(
            resolver_token=_RESOLVER_TOKEN,
            request=request,
            role=role,
            nonce=nonce,
            container_name=prefix,
            policy=policy,
            volume_names=volume_names,
            environment=environment,
            labels=labels,
        )


@dataclass(frozen=True)
class ImageEvidence:
    image_id: str | None
    platform: str | None
    provenance_sha256: str | None
    errors: tuple[str, ...]


def _image_evidence(image: ImageProtocol, expected_image_id: str) -> ImageEvidence:
    errors: list[str] = []
    image_id_value = image.attrs.get("Id")
    image_id = image_id_value if isinstance(image_id_value, str) else None
    if image_id is None or _IMAGE_ID.fullmatch(image_id) is None:
        errors.append("image inspect ID is unavailable or malformed")
        image_id = None
    if image.id != image_id:
        errors.append("image object and inspect IDs differ")
    os_name = image.attrs.get("Os")
    architecture = image.attrs.get("Architecture")
    platform = (
        f"{os_name}/{architecture}"
        if isinstance(os_name, str) and isinstance(architecture, str)
        else None
    )
    config = image.attrs.get("Config")
    labels: Mapping[str, object] = {}
    if isinstance(config, Mapping):
        labels_value = config.get("Labels")
        if isinstance(labels_value, Mapping):
            labels = labels_value
    provenance_value = labels.get(IMAGE_PROVENANCE_LABEL)
    provenance = provenance_value if isinstance(provenance_value, str) else None
    if provenance is None or _SHA256.fullmatch(provenance) is None:
        errors.append("image provenance label is unavailable or malformed")
        provenance = None
    if image_id != expected_image_id:
        errors.append("actual image ID differs from the candidate")
    return ImageEvidence(image_id, platform, provenance, tuple(errors))


@dataclass(frozen=True)
class ObservedMount:
    type: Literal["bind", "volume", "tmpfs"]
    source: str | None
    destination: str
    read_write: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "type": self.type,
            "source": self.source,
            "destination": self.destination,
            "read_write": self.read_write,
        }


ControllerMountSignature = tuple[object, object, object, object]


def controller_mount_signatures_match_exact_allowlist(
    mounts: Sequence[ControllerMountSignature],
    compose_project: str,
) -> bool:
    actual_mounts = frozenset(mounts)
    if len(mounts) != 4 or len(actual_mounts) != 4:
        return False
    return any(
        actual_mounts
        == frozenset(
            {
                ("bind", socket_source, "/var/run/docker.sock", True),
                (
                    "volume",
                    f"{compose_project}_controller-work-v2",
                    "/var/lib/repofix/controller",
                    True,
                ),
                (
                    "volume",
                    f"{compose_project}_controller-candidates-v1",
                    "/etc/repofixlab/candidates",
                    False,
                ),
                ("tmpfs", None, "/tmp", True),
            }
        )
        for socket_source in CONTROLLER_DOCKER_SOCKET_SOURCES
    )


@dataclass(frozen=True)
class ControllerExecutionNetwork:
    network_id: str
    compose_project: str
    compose_network: str
    internal: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "network_id": self.network_id,
            "compose_project": self.compose_project,
            "compose_network": self.compose_network,
            "internal": self.internal,
        }


@dataclass(frozen=True)
class ControllerExecutionEvidence:
    container_hostname: str
    container_id: str
    image_id: str
    compose_project: str
    compose_service: str
    compose_config_sha256: str
    read_only_root_filesystem: bool
    cap_drop: tuple[str, ...]
    security_opt: tuple[str, ...]
    published_ports: tuple[str, ...]
    networks: tuple[ControllerExecutionNetwork, ...]
    mounts: tuple[ObservedMount, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "container_hostname": self.container_hostname,
            "container_id": self.container_id,
            "image_id": self.image_id,
            "compose_project": self.compose_project,
            "compose_service": self.compose_service,
            "compose_config_sha256": self.compose_config_sha256,
            "read_only_root_filesystem": self.read_only_root_filesystem,
            "cap_drop": list(self.cap_drop),
            "security_opt": list(self.security_opt),
            "published_ports": list(self.published_ports),
            "networks": [network.to_dict() for network in self.networks],
            "mounts": [mount.to_dict() for mount in self.mounts],
        }


@dataclass(frozen=True)
class RuntimeInspectEvidence:
    configured_user: str
    uid: int
    gid: int
    network_mode: str
    read_only_root_filesystem: bool
    cap_drop: tuple[str, ...]
    cap_add: tuple[str, ...]
    security_opt: tuple[str, ...]
    privileged: bool
    device_count: int
    nano_cpus: int
    memory_bytes: int
    memory_swap_bytes: int
    pids_limit: int
    tty: bool
    stdin_open: bool
    auto_remove: bool
    published_ports: tuple[str, ...]
    mounts: tuple[ObservedMount, ...]
    docker_socket_paths_present: tuple[str, ...]
    sensitive_environment_names_present: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "configured_user": self.configured_user,
            "uid": self.uid,
            "gid": self.gid,
            "network_mode": self.network_mode,
            "read_only_root_filesystem": self.read_only_root_filesystem,
            "cap_drop": list(self.cap_drop),
            "cap_add": list(self.cap_add),
            "security_opt": list(self.security_opt),
            "privileged": self.privileged,
            "device_count": self.device_count,
            "nano_cpus": self.nano_cpus,
            "memory_bytes": self.memory_bytes,
            "memory_swap_bytes": self.memory_swap_bytes,
            "pids_limit": self.pids_limit,
            "tty": self.tty,
            "stdin_open": self.stdin_open,
            "auto_remove": self.auto_remove,
            "published_ports": list(self.published_ports),
            "mounts": [mount.to_dict() for mount in self.mounts],
            "docker_socket_paths_present": list(self.docker_socket_paths_present),
            "sensitive_environment_names_present": list(
                self.sensitive_environment_names_present
            ),
        }


def _string_tuple(value: object, name: str, errors: list[str]) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        errors.append(f"{name} inspection is malformed")
        return ()
    return tuple(sorted(set(value)))


def _environment(value: object, errors: list[str]) -> dict[str, str]:
    if not isinstance(value, list):
        errors.append("container environment is unavailable")
        return {}
    parsed: dict[str, str] = {}
    for entry in value:
        if not isinstance(entry, str) or "=" not in entry:
            errors.append("container environment entry is malformed")
            continue
        name, environment_value = entry.split("=", 1)
        if name in parsed:
            errors.append(f"container environment contains duplicate {name}")
        parsed[name] = environment_value
    return parsed


def _published_ports(
    host_config: Mapping[str, object],
    network_settings: Mapping[str, object],
    errors: list[str],
) -> tuple[str, ...]:
    published: set[str] = set()
    for source_name, value in (
        ("HostConfig", host_config.get("PortBindings")),
        ("NetworkSettings", network_settings.get("Ports")),
    ):
        if value in (None, {}):
            continue
        if not isinstance(value, Mapping):
            errors.append(f"{source_name} port inspection is malformed")
            continue
        for container_port, bindings in value.items():
            if bindings in (None, []):
                continue
            if not isinstance(container_port, str) or not isinstance(bindings, list):
                errors.append(f"{source_name} port binding is malformed")
                continue
            for binding in bindings:
                if not isinstance(binding, Mapping):
                    errors.append(f"{source_name} port binding is malformed")
                    continue
                host_ip = binding.get("HostIp") or "0.0.0.0"
                host_port = binding.get("HostPort")
                if isinstance(host_ip, str) and isinstance(host_port, str) and host_port:
                    published.add(f"{host_ip}:{host_port}->{container_port}")
                else:
                    errors.append(f"{source_name} port binding is malformed")
    return tuple(sorted(published))


def inspect_controller_execution(
    client: DockerClientProtocol,
    *,
    container_hostname: str,
    compose_project: str,
) -> ControllerExecutionEvidence:
    if _CONTAINER_HOSTNAME.fullmatch(container_hostname) is None:
        raise ContainerFactoryError("Controller hostname is not a Docker ID prefix")
    if _COMPOSE_NAME.fullmatch(compose_project) is None:
        raise ContainerFactoryError("Controller Compose project is malformed")
    try:
        container = client.containers.get(container_hostname)
    except Exception as error:
        raise ContainerFactoryError(
            "Controller container cannot be resolved from its hostname"
        ) from error
    container_id = container.id
    if (
        _CONTAINER_ID.fullmatch(container_id) is None
        or not container_id.startswith(container_hostname)
        or container.attrs.get("Id") != container_id
    ):
        raise ContainerFactoryError(
            "Controller hostname and exact inspected container ID do not match"
        )

    config = container.attrs.get("Config")
    host_config = container.attrs.get("HostConfig")
    network_settings = container.attrs.get("NetworkSettings")
    mounts_value = container.attrs.get("Mounts")
    if (
        not isinstance(config, Mapping)
        or not isinstance(host_config, Mapping)
        or not isinstance(network_settings, Mapping)
        or not isinstance(mounts_value, list)
    ):
        raise ContainerFactoryError("Controller inspect envelope is unavailable")
    labels_value = config.get("Labels")
    if not isinstance(labels_value, Mapping):
        raise ContainerFactoryError("Controller Compose labels are unavailable")
    compose_service = labels_value.get("com.docker.compose.service")
    observed_project = labels_value.get("com.docker.compose.project")
    container_config_sha256 = labels_value.get("com.docker.compose.config-hash")
    if observed_project != compose_project or compose_service != "controller":
        raise ContainerFactoryError("Controller Compose identity does not match")
    if (
        not isinstance(container_config_sha256, str)
        or _SHA256.fullmatch(container_config_sha256) is None
    ):
        raise ContainerFactoryError("Controller Compose config hash is unavailable")

    image_id = container.attrs.get("Image")
    if not isinstance(image_id, str) or _IMAGE_ID.fullmatch(image_id) is None:
        raise ContainerFactoryError("Controller exact running image ID is unavailable")
    try:
        image = client.images.get(image_id)
    except Exception as error:
        raise ContainerFactoryError("Controller running image cannot be inspected") from error
    image_config = image.attrs.get("Config")
    image_labels_value = (
        image_config.get("Labels") if isinstance(image_config, Mapping) else None
    )
    compose_config_sha256 = (
        image_labels_value.get(IMAGE_COMPOSE_CONFIG_LABEL)
        if isinstance(image_labels_value, Mapping)
        else None
    )
    if (
        image.id != image_id
        or image.attrs.get("Id") != image_id
        or not isinstance(compose_config_sha256, str)
        or _SHA256.fullmatch(compose_config_sha256) is None
        or compose_config_sha256 != container_config_sha256
    ):
        raise ContainerFactoryError(
            "Controller running image or Compose config binding does not match"
        )

    errors: list[str] = []
    cap_drop = _string_tuple(host_config.get("CapDrop"), "Controller CapDrop", errors)
    security_opt = _string_tuple(
        host_config.get("SecurityOpt"), "Controller SecurityOpt", errors
    )
    published_ports = _published_ports(host_config, network_settings, errors)
    read_only_root = host_config.get("ReadonlyRootfs")
    if read_only_root is not True:
        errors.append("Controller root filesystem is not read-only")
    if cap_drop != ("ALL",):
        errors.append("Controller capability drop is not exactly ALL")
    if security_opt != ("no-new-privileges:true",):
        errors.append("Controller no-new-privileges policy is not exact")
    if published_ports:
        errors.append("Controller publishes host ports")

    attachments = network_settings.get("Networks")
    networks: list[ControllerExecutionNetwork] = []
    if not isinstance(attachments, Mapping) or len(attachments) != 1:
        errors.append("Controller must have exactly one network attachment")
    else:
        attachment_name, attachment_value = next(iter(attachments.items()))
        if not isinstance(attachment_name, str) or not isinstance(
            attachment_value, Mapping
        ):
            errors.append("Controller network attachment is malformed")
        else:
            network_id = attachment_value.get("NetworkID")
            if not isinstance(network_id, str) or _CONTAINER_ID.fullmatch(network_id) is None:
                errors.append("Controller network ID is malformed")
            else:
                try:
                    network = client.networks.get(network_id)
                    network_labels_value = network.attrs.get("Labels")
                    network_labels = (
                        network_labels_value
                        if isinstance(network_labels_value, Mapping)
                        else {}
                    )
                    internal = network.attrs.get("Internal")
                    if (
                        network.attrs.get("Id") != network_id
                        or internal is not True
                        or network_labels.get("com.docker.compose.project")
                        != compose_project
                        or network_labels.get("com.docker.compose.network")
                        != "repofix-control"
                    ):
                        errors.append(
                            "Controller network is not the unique internal Compose control network"
                        )
                    else:
                        networks.append(
                            ControllerExecutionNetwork(
                                network_id=network_id,
                                compose_project=compose_project,
                                compose_network="repofix-control",
                                internal=True,
                            )
                        )
                except Exception as error:
                    errors.append(
                        f"Controller network inspect failed: {type(error).__name__}"
                    )

    observed_mounts: list[ObservedMount] = []
    tmpfs_destinations: set[str] = set()
    for mount_value in mounts_value:
        if not isinstance(mount_value, Mapping):
            errors.append("Controller mount inspection is malformed")
            continue
        mount_type = mount_value.get("Type")
        destination = mount_value.get("Destination")
        read_write = mount_value.get("RW")
        if (
            mount_type not in {"bind", "volume", "tmpfs"}
            or not isinstance(destination, str)
            or not isinstance(read_write, bool)
        ):
            errors.append("Controller mount fields are malformed")
            continue
        if mount_type == "bind":
            source_value = mount_value.get("Source")
        elif mount_type == "volume":
            source_value = mount_value.get("Name")
        else:
            source_value = None
            tmpfs_destinations.add(destination)
        source = (
            source_value
            if isinstance(source_value, str) and source_value
            else None
        )
        if mount_type != "tmpfs" and source is None:
            errors.append("Controller bind or volume source is unavailable")
        observed_mounts.append(
            ObservedMount(mount_type, source, destination, read_write)
        )
    tmpfs_value = host_config.get("Tmpfs")
    if not isinstance(tmpfs_value, Mapping) or set(tmpfs_value) != {"/tmp"}:
        errors.append("Controller tmpfs configuration is not exactly /tmp")
    else:
        if "/tmp" not in tmpfs_destinations:
            observed_mounts.append(ObservedMount("tmpfs", None, "/tmp", True))
    observed_mounts.sort(
        key=lambda mount: (mount.type, mount.destination, mount.source or "")
    )
    actual_mounts = tuple(
        (mount.type, mount.source, mount.destination, mount.read_write)
        for mount in observed_mounts
    )
    if not controller_mount_signatures_match_exact_allowlist(
        actual_mounts, compose_project
    ):
        errors.append("Controller mounts are outside the exact allowlist")
    if errors:
        raise ContainerFactoryError("; ".join(errors))
    return ControllerExecutionEvidence(
        container_hostname=container_hostname,
        container_id=container_id,
        image_id=image_id,
        compose_project=compose_project,
        compose_service="controller",
        compose_config_sha256=compose_config_sha256,
        read_only_root_filesystem=True,
        cap_drop=cap_drop,
        security_opt=security_opt,
        published_ports=published_ports,
        networks=tuple(networks),
        mounts=tuple(observed_mounts),
    )


def _runtime_inspect(
    container: ContainerProtocol,
    spec: ResolvedRoleLaunchSpec,
) -> tuple[RuntimeInspectEvidence | None, tuple[str, ...]]:
    errors: list[str] = []
    config = container.attrs.get("Config")
    host_config = container.attrs.get("HostConfig")
    network_settings = container.attrs.get("NetworkSettings")
    mounts_value = container.attrs.get("Mounts")
    if (
        not isinstance(config, Mapping)
        or not isinstance(host_config, Mapping)
        or not isinstance(network_settings, Mapping)
        or not isinstance(mounts_value, list)
    ):
        return None, ("container inspect envelope is unavailable",)
    configured_user = config.get("User")
    user_match = _USER.fullmatch(configured_user) if isinstance(configured_user, str) else None
    if user_match is None:
        return None, ("container configured user is malformed",)
    environment = _environment(config.get("Env"), errors)
    sensitive_names = tuple(
        sorted(name for name in environment if name in _SENSITIVE_ENVIRONMENT_NAMES)
    )
    unexpected_names = sorted(
        name for name in environment if name not in spec.allowed_environment_names
    )
    if unexpected_names:
        errors.append(f"container environment is outside allowlist: {unexpected_names}")
    for name, expected in spec.environment.items():
        if environment.get(name) != expected:
            errors.append(f"container environment binding {name} drifted")

    observed_mounts: list[ObservedMount] = []
    socket_paths: set[str] = set()
    tmpfs_destinations: set[str] = set()
    for mount in mounts_value:
        if not isinstance(mount, Mapping):
            errors.append("container mount inspection is malformed")
            continue
        mount_type = mount.get("Type")
        destination = mount.get("Destination")
        read_write = mount.get("RW")
        if (
            mount_type not in {"bind", "volume", "tmpfs"}
            or not isinstance(destination, str)
            or not isinstance(read_write, bool)
        ):
            errors.append("container mount fields are malformed")
            continue
        if mount_type == "volume":
            source_value = mount.get("Name")
        elif mount_type == "bind":
            source_value = mount.get("Source")
        else:
            source_value = None
            tmpfs_destinations.add(destination)
        source = source_value if isinstance(source_value, str) and source_value else None
        if mount_type != "tmpfs" and source is None:
            errors.append("container bind or volume mount source is unavailable")
        if destination in _DOCKER_SOCKET_PATHS or source in _DOCKER_SOCKET_PATHS:
            socket_paths.add(destination if destination in _DOCKER_SOCKET_PATHS else str(source))
        observed_mounts.append(
            ObservedMount(mount_type, source, destination, read_write)
        )

    tmpfs_value = host_config.get("Tmpfs")
    if tmpfs_value is None:
        tmpfs: Mapping[object, object] = {}
    elif isinstance(tmpfs_value, Mapping):
        tmpfs = tmpfs_value
    else:
        errors.append("HostConfig Tmpfs inspection is malformed")
        tmpfs = {}
    expected_tmpfs = {mount.target: mount.options for mount in spec.policy.tmpfs}
    if tmpfs != expected_tmpfs:
        errors.append("container tmpfs configuration drifted")
    for destination in tmpfs:
        if isinstance(destination, str) and destination not in tmpfs_destinations:
            observed_mounts.append(ObservedMount("tmpfs", None, destination, True))

    observed_mounts.sort(
        key=lambda mount: (mount.type, mount.destination, mount.source or "")
    )
    cap_drop = _string_tuple(host_config.get("CapDrop"), "CapDrop", errors)
    cap_add = _string_tuple(host_config.get("CapAdd"), "CapAdd", errors)
    security_opt = _string_tuple(host_config.get("SecurityOpt"), "SecurityOpt", errors)
    devices = host_config.get("Devices")
    if devices is None:
        device_count = 0
    elif isinstance(devices, list):
        device_count = len(devices)
    else:
        errors.append("device inspection is malformed")
        device_count = 0

    integer_fields: dict[str, int] = {}
    for report_name, inspect_name in (
        ("nano_cpus", "NanoCpus"),
        ("memory_bytes", "Memory"),
        ("memory_swap_bytes", "MemorySwap"),
        ("pids_limit", "PidsLimit"),
    ):
        value = host_config.get(inspect_name)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            errors.append(f"HostConfig {inspect_name} is malformed")
            integer_fields[report_name] = 0
        else:
            integer_fields[report_name] = value
    network_mode = host_config.get("NetworkMode")
    if not isinstance(network_mode, str) or not network_mode:
        errors.append("container network mode is unavailable")
        network_mode = "unknown"
    bool_fields: dict[str, bool] = {}
    for report_name, value in (
        ("read_only_root_filesystem", host_config.get("ReadonlyRootfs")),
        ("privileged", host_config.get("Privileged")),
        ("auto_remove", host_config.get("AutoRemove")),
        ("tty", config.get("Tty")),
        ("stdin_open", config.get("OpenStdin")),
    ):
        if not isinstance(value, bool):
            errors.append(f"container {report_name} inspection is malformed")
            bool_fields[report_name] = False
        else:
            bool_fields[report_name] = value
    evidence = RuntimeInspectEvidence(
        configured_user=configured_user,
        uid=int(user_match.group(1)),
        gid=int(user_match.group(2)),
        network_mode=network_mode,
        read_only_root_filesystem=bool_fields["read_only_root_filesystem"],
        cap_drop=cap_drop,
        cap_add=cap_add,
        security_opt=security_opt,
        privileged=bool_fields["privileged"],
        device_count=device_count,
        nano_cpus=integer_fields["nano_cpus"],
        memory_bytes=integer_fields["memory_bytes"],
        memory_swap_bytes=integer_fields["memory_swap_bytes"],
        pids_limit=integer_fields["pids_limit"],
        tty=bool_fields["tty"],
        stdin_open=bool_fields["stdin_open"],
        auto_remove=bool_fields["auto_remove"],
        published_ports=_published_ports(host_config, network_settings, errors),
        mounts=tuple(observed_mounts),
        docker_socket_paths_present=tuple(sorted(socket_paths)),
        sensitive_environment_names_present=sensitive_names,
    )
    expected_mounts = sorted(
        [("volume", mount.target, True) for mount in spec.policy.managed_volumes]
        + [("tmpfs", mount.target, True) for mount in spec.policy.tmpfs]
    )
    actual_mounts = sorted(
        (mount.type, mount.destination, mount.read_write) for mount in evidence.mounts
    )
    expected_sources = sorted(spec.volume_names.values())
    actual_sources = sorted(
        mount.source
        for mount in evidence.mounts
        if mount.type == "volume" and mount.source is not None
    )
    expected_values: Mapping[str, object] = {
        "configured_user": spec.policy.user,
        "uid": spec.expected_uid,
        "gid": spec.expected_gid,
        "network_mode": "none",
        "read_only_root_filesystem": True,
        "cap_drop": ("ALL",),
        "cap_add": (),
        "security_opt": ("no-new-privileges:true",),
        "privileged": False,
        "device_count": 0,
        "nano_cpus": spec.policy.nano_cpus,
        "memory_bytes": spec.policy.memory_bytes,
        "memory_swap_bytes": spec.policy.memory_swap_bytes,
        "pids_limit": spec.policy.pids_limit,
        "tty": False,
        "stdin_open": False,
        "auto_remove": False,
        "published_ports": (),
        "docker_socket_paths_present": (),
        "sensitive_environment_names_present": (),
    }
    for name, expected in expected_values.items():
        if getattr(evidence, name) != expected:
            errors.append(f"runtime inspect {name} differs from the candidate")
    if actual_mounts != expected_mounts or actual_sources != expected_sources:
        errors.append("runtime inspect mounts differ from the candidate")
    if config.get("Image") != spec.policy.image_id:
        errors.append("container Config image differs from the candidate")
    if config.get("ExposedPorts") not in (None, {}):
        errors.append("container image exposes ports")
    expected_binds = sorted(
        f"{spec.volume_names[mount.key]}:{mount.target}:rw"
        for mount in spec.policy.managed_volumes
    )
    binds = host_config.get("Binds")
    actual_binds = sorted(binds) if isinstance(binds, list) else []
    if actual_binds != expected_binds:
        errors.append("container managed-volume binds drifted")
    networks = network_settings.get("Networks")
    if networks not in (None, {}) and not (
        isinstance(networks, Mapping) and set(networks) == {"none"}
    ):
        errors.append("container has a network attachment")
    return evidence, tuple(errors)


@dataclass(frozen=True)
class ActiveProbeEvidence:
    status: Literal["pass", "fail"]
    probe_sha256: str
    nonce_sha256: str
    exit_code: int | None
    timed_out: bool
    duration_ms: int
    stdout_sha256: str | None
    stderr_sha256: str | None
    observed_uid: int | None
    observed_gid: int | None
    observed_base_commit: str | None
    writable_path_roundtrip: bool
    docker_socket_paths_present: tuple[str, ...]
    sensitive_environment_names_present: tuple[str, ...]
    errors: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "probe_sha256": self.probe_sha256,
            "nonce_sha256": self.nonce_sha256,
            "exit_code": self.exit_code,
            "timed_out": self.timed_out,
            "duration_ms": self.duration_ms,
            "stdout_sha256": self.stdout_sha256,
            "stderr_sha256": self.stderr_sha256,
            "observed_uid": self.observed_uid,
            "observed_gid": self.observed_gid,
            "observed_base_commit": self.observed_base_commit,
            "writable_path_roundtrip": self.writable_path_roundtrip,
            "docker_socket_paths_present": list(self.docker_socket_paths_present),
            "sensitive_environment_names_present": list(
                self.sensitive_environment_names_present
            ),
            "errors": list(self.errors),
        }


def _active_probe_evidence(
    spec: ResolvedRoleLaunchSpec,
    *,
    stdout: bytes | None,
    stderr: bytes | None,
    exit_code: int | None,
    timed_out: bool,
    duration_ms: int,
    initial_errors: tuple[str, ...] = (),
) -> ActiveProbeEvidence:
    errors = list(initial_errors)
    value: object = None
    if stdout is not None:
        if len(stdout) > 64 * 1024:
            errors.append("active probe stdout exceeds 64 KiB")
        else:
            try:
                lines = stdout.decode("utf-8", errors="strict").splitlines()
                if len(lines) != 1 or not lines[0]:
                    errors.append("active probe must emit exactly one JSON line")
                else:
                    value = json.loads(lines[0])
            except (UnicodeDecodeError, json.JSONDecodeError):
                errors.append("active probe stdout is not canonical UTF-8 JSON")
    else:
        errors.append("active probe stdout was not collected")
    expected_keys = {
        "schema_version",
        "probe_type",
        "probe_sha256",
        "nonce",
        "observed_uid",
        "observed_gid",
        "observed_base_commit",
        "writable_path_roundtrip",
        "docker_socket_paths_present",
        "sensitive_environment_names_present",
        "errors",
    }
    payload = value if isinstance(value, dict) else {}
    if set(payload) != expected_keys:
        errors.append("active probe envelope is not exact")
    if payload.get("schema_version") != "v1" or payload.get("probe_type") != "task_role_factory_active_probe":
        errors.append("active probe schema or type differs")
    if payload.get("probe_sha256") != spec.request.probe_sha256:
        errors.append("active probe SHA-256 differs from the candidate")
    if payload.get("nonce") != spec.nonce:
        errors.append("active probe nonce differs")
    observed_uid_value = payload.get("observed_uid")
    observed_gid_value = payload.get("observed_gid")
    observed_uid = (
        observed_uid_value
        if isinstance(observed_uid_value, int) and not isinstance(observed_uid_value, bool)
        else None
    )
    observed_gid = (
        observed_gid_value
        if isinstance(observed_gid_value, int) and not isinstance(observed_gid_value, bool)
        else None
    )
    base_commit_value = payload.get("observed_base_commit")
    observed_base_commit = (
        base_commit_value
        if isinstance(base_commit_value, str) and _HEAD_SHA.fullmatch(base_commit_value)
        else None
    )
    writable_roundtrip = payload.get("writable_path_roundtrip") is True
    socket_value = payload.get("docker_socket_paths_present")
    sensitive_value = payload.get("sensitive_environment_names_present")
    socket_paths = tuple(
        sorted(
            value
            for value in socket_value
            if isinstance(value, str) and value in _DOCKER_SOCKET_PATHS
        )
    ) if isinstance(socket_value, list) else ()
    sensitive_names = tuple(
        sorted(
            value
            for value in sensitive_value
            if isinstance(value, str) and value in _SENSITIVE_ENVIRONMENT_NAMES
        )
    ) if isinstance(sensitive_value, list) else ()
    if not isinstance(socket_value, list) or len(socket_paths) != len(socket_value):
        errors.append("active probe Docker socket observations are malformed")
    if not isinstance(sensitive_value, list) or len(sensitive_names) != len(sensitive_value):
        errors.append("active probe sensitive environment observations are malformed")
    payload_errors = payload.get("errors")
    if not isinstance(payload_errors, list) or any(
        not isinstance(error, str) or not error for error in payload_errors
    ):
        errors.append("active probe errors are malformed")
    else:
        errors.extend(payload_errors)
    if observed_uid != spec.expected_uid:
        errors.append("active probe UID differs from the candidate")
    if observed_gid != spec.expected_gid:
        errors.append("active probe GID differs from the candidate")
    if observed_base_commit != spec.request.base_commit:
        errors.append("active probe base commit differs from the candidate")
    if not writable_roundtrip:
        errors.append("active probe writable path roundtrip failed")
    if socket_paths:
        errors.append("active probe observed a Docker socket")
    if sensitive_names:
        errors.append("active probe observed sensitive environment names")
    if exit_code != 0:
        errors.append("active probe exit code is not zero")
    if timed_out:
        errors.append("active probe timed out")
    if duration_ms > spec.policy.timeout_seconds * 1000:
        errors.append("active probe exceeded the candidate timeout")
    return ActiveProbeEvidence(
        status="pass" if not errors else "fail",
        probe_sha256=spec.request.probe_sha256,
        nonce_sha256=hashlib.sha256(spec.nonce.encode()).hexdigest(),
        exit_code=exit_code,
        timed_out=timed_out,
        duration_ms=max(duration_ms, 0),
        stdout_sha256=hashlib.sha256(stdout).hexdigest() if stdout is not None else None,
        stderr_sha256=hashlib.sha256(stderr).hexdigest() if stderr is not None else None,
        observed_uid=observed_uid,
        observed_gid=observed_gid,
        observed_base_commit=observed_base_commit,
        writable_path_roundtrip=writable_roundtrip,
        docker_socket_paths_present=socket_paths,
        sensitive_environment_names_present=sensitive_names,
        errors=tuple(errors),
    )


@dataclass(frozen=True)
class CleanupEvidence:
    container_removal_attempted: bool
    container_removed: bool
    created_volume_names: tuple[str, ...]
    removed_volume_names: tuple[str, ...]
    residual_container_ids: tuple[str, ...]
    residual_volume_names: tuple[str, ...]
    errors: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "container_removal_attempted": self.container_removal_attempted,
            "container_removed": self.container_removed,
            "created_volume_names": list(self.created_volume_names),
            "removed_volume_names": list(self.removed_volume_names),
            "residual_container_ids": list(self.residual_container_ids),
            "residual_volume_names": list(self.residual_volume_names),
            "errors": list(self.errors),
        }


@dataclass(frozen=True)
class RoleFactoryEvidence:
    role: Role
    status: Literal["pass", "fail"]
    failure_phase: FailurePhase | None
    container_id: str | None
    expected_image_id: str
    actual_image_id: str | None
    expected_platform: str
    actual_platform: str | None
    expected_provenance_sha256: str
    actual_provenance_sha256: str | None
    inspect: RuntimeInspectEvidence | None
    active_probe: ActiveProbeEvidence | None
    cleanup: CleanupEvidence
    errors: tuple[str, ...]

    def unsigned_dict(self) -> dict[str, object]:
        return {
            "role": self.role,
            "status": self.status,
            "failure_phase": self.failure_phase,
            "container_id": self.container_id,
            "expected_image_id": self.expected_image_id,
            "actual_image_id": self.actual_image_id,
            "expected_platform": self.expected_platform,
            "actual_platform": self.actual_platform,
            "expected_provenance_sha256": self.expected_provenance_sha256,
            "actual_provenance_sha256": self.actual_provenance_sha256,
            "inspect": self.inspect.to_dict() if self.inspect else None,
            "active_probe": self.active_probe.to_dict() if self.active_probe else None,
            "cleanup": self.cleanup.to_dict(),
            "errors": list(self.errors),
        }

    def to_dict(self) -> dict[str, object]:
        value = self.unsigned_dict()
        value["evidence_sha256"] = _canonical_sha256(value)
        return value


@dataclass(frozen=True)
class TaskRoleFactoryProbeReport:
    request: ResolvedProbeRequest
    controller_execution: ControllerExecutionEvidence
    status: Literal["pass", "fail"]
    started_at: str
    finished_at: str
    worker: RoleFactoryEvidence
    evaluator: RoleFactoryEvidence
    errors: tuple[str, ...]

    def unsigned_dict(self) -> dict[str, object]:
        return {
            "schema_version": "v1",
            "report_type": "task_role_factory_probe",
            "operation_id": self.request.operation_id,
            "request_sha256": self.request.request_sha256,
            "candidate_id": self.request.candidate_id,
            "candidate_sha256": self.request.candidate_sha256,
            "probe_profile": self.request.probe_profile,
            "instance_id": self.request.instance_id,
            "base_commit": self.request.base_commit,
            "controller_execution": self.controller_execution.to_dict(),
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "execution_order": ["worker", "evaluator"],
            "roles": {
                "worker": self.worker.to_dict(),
                "evaluator": self.evaluator.to_dict(),
            },
            "errors": list(self.errors),
        }

    def to_dict(self) -> dict[str, object]:
        value = self.unsigned_dict()
        value["report_sha256"] = _canonical_sha256(value)
        return value


def _empty_cleanup() -> CleanupEvidence:
    return CleanupEvidence(False, False, (), (), (), (), ())


def _unexecuted_role(
    request: ResolvedProbeRequest,
    role: Role,
    reason: str,
    *,
    cleanup: CleanupEvidence | None = None,
    failure_phase: FailurePhase = "candidate_validation",
) -> RoleFactoryEvidence:
    policy = request.worker if role == "worker" else request.evaluator
    return RoleFactoryEvidence(
        role=role,
        status="fail",
        failure_phase=failure_phase,
        container_id=None,
        expected_image_id=policy.image_id,
        actual_image_id=None,
        expected_platform="linux/amd64",
        actual_platform=None,
        expected_provenance_sha256=policy.provenance_sha256,
        actual_provenance_sha256=None,
        inspect=None,
        active_probe=None,
        cleanup=cleanup or _empty_cleanup(),
        errors=(reason,),
    )


def _skipped_evaluator(request: ResolvedProbeRequest) -> RoleFactoryEvidence:
    return _unexecuted_role(
        request,
        "evaluator",
        "evaluator was not created because worker hard gates failed",
    )


def _resource_filters(labels: Mapping[str, str]) -> Mapping[str, object]:
    return {"label": [f"{name}={value}" for name, value in sorted(labels.items())]}


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class RoleContainerFactory:
    def __init__(
        self,
        client: DockerClientProtocol,
        resolver: TrustedCandidateResolver,
        *,
        controller_execution: ControllerExecutionEvidence,
        nonce_factory: Callable[[], str] = lambda: uuid4().hex,
        clock: Callable[[], str] = _now,
        monotonic_ms: Callable[[], int] = lambda: monotonic_ns() // 1_000_000,
    ) -> None:
        self._client = client
        self._resolver = resolver
        self._controller_execution = controller_execution
        self._nonce_factory = nonce_factory
        self._clock = clock
        self._monotonic_ms = monotonic_ms

    def execute_probe(
        self,
        request: ResolvedProbeRequest,
    ) -> TaskRoleFactoryProbeReport:
        started_at = self._clock()
        worker = self._execute_role(request, "worker")
        if worker.status == "pass":
            evaluator = self._execute_role(request, "evaluator")
        else:
            evaluator = _skipped_evaluator(request)
        status: Literal["pass", "fail"] = (
            "pass" if worker.status == evaluator.status == "pass" else "fail"
        )
        return TaskRoleFactoryProbeReport(
            request=request,
            controller_execution=self._controller_execution,
            status=status,
            started_at=started_at,
            finished_at=self._clock(),
            worker=worker,
            evaluator=evaluator,
            errors=(),
        )

    def interrupted_probe_report(
        self,
        request: ResolvedProbeRequest,
        *,
        started_at: str,
        finished_at: str,
        error: str,
    ) -> TaskRoleFactoryProbeReport:
        return TaskRoleFactoryProbeReport(
            request=request,
            controller_execution=self._controller_execution,
            status="fail",
            started_at=started_at,
            finished_at=finished_at,
            worker=_unexecuted_role(request, "worker", error),
            evaluator=_unexecuted_role(request, "evaluator", error),
            errors=(error,),
        )

    def recover_interrupted_probe(
        self,
        request: ResolvedProbeRequest,
        *,
        started_at: str,
        finished_at: str,
    ) -> TaskRoleFactoryProbeReport:
        worker = self._recover_role_resources(request, "worker")
        evaluator = self._recover_role_resources(request, "evaluator")
        return TaskRoleFactoryProbeReport(
            request=request,
            controller_execution=self._controller_execution,
            status="fail",
            started_at=started_at,
            finished_at=finished_at,
            worker=worker,
            evaluator=evaluator,
            errors=(
                "operation was interrupted before a durable terminal report and was not re-executed",
            ),
        )

    def _recover_role_resources(
        self,
        request: ResolvedProbeRequest,
        role: Role,
    ) -> RoleFactoryEvidence:
        labels = {
            _MANAGED_LABEL: "true",
            _OPERATION_LABEL: request.operation_id,
            _CANDIDATE_LABEL: request.candidate_id,
            _ROLE_LABEL: role,
        }
        filters = _resource_filters(labels)
        errors: list[str] = []
        initial_containers: list[ContainerProtocol] = []
        initial_volumes: list[VolumeProtocol] = []
        try:
            initial_containers = self._client.containers.list(
                all=True,
                filters=filters,
            )
        except Exception as error:
            errors.append(
                f"interrupted container listing: {type(error).__name__}: {error}"
            )
        try:
            initial_volumes = self._client.volumes.list(filters=filters)
        except Exception as error:
            errors.append(
                f"interrupted volume listing: {type(error).__name__}: {error}"
            )

        removed_volumes: list[str] = []
        container_removal_attempted = bool(initial_containers)
        removed_containers = 0
        for container in initial_containers:
            try:
                container.remove(force=True)
                removed_containers += 1
            except Exception as error:
                errors.append(
                    f"interrupted container removal: {type(error).__name__}: {error}"
                )
        for volume in initial_volumes:
            try:
                volume.remove(force=True)
                removed_volumes.append(volume.name)
            except Exception as error:
                errors.append(
                    f"interrupted volume removal: {type(error).__name__}: {error}"
                )

        residual_container_ids: tuple[str, ...] = ()
        residual_volume_names: tuple[str, ...] = ()
        try:
            residual_containers = self._client.containers.list(
                all=True,
                filters=filters,
            )
            residual_container_ids = tuple(
                sorted(
                    container.id
                    for container in residual_containers
                    if _CONTAINER_ID.fullmatch(container.id)
                )
            )
            if len(residual_container_ids) != len(residual_containers):
                errors.append("interrupted residual container ID is malformed")
        except Exception as error:
            errors.append(
                f"interrupted residual container audit: {type(error).__name__}: {error}"
            )
        try:
            residual_volumes = self._client.volumes.list(filters=filters)
            residual_volume_names = tuple(
                sorted(volume.name for volume in residual_volumes)
            )
        except Exception as error:
            errors.append(
                f"interrupted residual volume audit: {type(error).__name__}: {error}"
            )
        cleanup = CleanupEvidence(
            container_removal_attempted=container_removal_attempted,
            container_removed=(
                container_removal_attempted
                and removed_containers == len(initial_containers)
            ),
            created_volume_names=tuple(
                sorted(volume.name for volume in initial_volumes)
            ),
            removed_volume_names=tuple(sorted(removed_volumes)),
            residual_container_ids=residual_container_ids,
            residual_volume_names=residual_volume_names,
            errors=tuple(errors),
        )
        cleanup_failed = bool(
            cleanup.errors
            or cleanup.residual_container_ids
            or cleanup.residual_volume_names
        )
        return _unexecuted_role(
            request,
            role,
            "role execution state was unknown after Controller restart and was not re-executed",
            cleanup=cleanup,
            failure_phase="cleanup" if cleanup_failed else "candidate_validation",
        )

    def _execute_role(
        self,
        request: ResolvedProbeRequest,
        role: Role,
    ) -> RoleFactoryEvidence:
        policy = request.worker if role == "worker" else request.evaluator
        errors: list[str] = []
        cleanup_errors: list[str] = []
        failure_phase: FailurePhase | None = None
        spec: ResolvedRoleLaunchSpec | None = None
        image_evidence = ImageEvidence(None, None, None, ())
        container: ContainerProtocol | None = None
        removal_target: ContainerProtocol | None = None
        container_id: str | None = None
        created_volumes: list[VolumeProtocol] = []
        removed_volume_names: list[str] = []
        container_removal_attempted = False
        container_removed = False
        inspect_evidence: RuntimeInspectEvidence | None = None
        active_evidence: ActiveProbeEvidence | None = None
        execution_passed = False
        probe_started_ms: int | None = None

        try:
            try:
                spec = self._resolver.resolve_role(
                    request,
                    role=role,
                    nonce=self._nonce_factory(),
                )
            except Exception as error:
                failure_phase = "candidate_validation"
                raise ContainerFactoryError(str(error)) from error

            try:
                image = self._client.images.get(policy.image_id)
                image_evidence = _image_evidence(image, policy.image_id)
                if image_evidence.errors:
                    raise ContainerFactoryError("; ".join(image_evidence.errors))
                if image_evidence.platform != "linux/amd64":
                    raise ContainerFactoryError("image platform differs from linux/amd64")
                if image_evidence.provenance_sha256 != policy.provenance_sha256:
                    raise ContainerFactoryError(
                        "image provenance label differs from the candidate"
                    )
            except Exception as error:
                failure_phase = "image_inspect"
                raise ContainerFactoryError(str(error)) from error

            try:
                for mount in policy.managed_volumes:
                    volume = self._client.volumes.create(
                        name=spec.volume_names[mount.key],
                        labels=dict(spec.labels),
                    )
                    created_volumes.append(volume)
                    if volume.name != spec.volume_names[mount.key]:
                        raise ContainerFactoryError("created volume name drifted")
                volumes = {
                    spec.volume_names[mount.key]: {
                        "bind": mount.target,
                        "mode": "rw",
                    }
                    for mount in policy.managed_volumes
                }
                tmpfs = {mount.target: mount.options for mount in policy.tmpfs}
                probe_started_ms = self._monotonic_ms()
                container = self._client.containers.run(
                    policy.image_id,
                    list(policy.command),
                    name=spec.container_name,
                    detach=True,
                    remove=False,
                    auto_remove=False,
                    platform="linux/amd64",
                    network_mode="none",
                    read_only=True,
                    cap_drop=["ALL"],
                    cap_add=[],
                    security_opt=["no-new-privileges:true"],
                    privileged=False,
                    devices=[],
                    ports={},
                    tty=False,
                    stdin_open=False,
                    user=policy.user,
                    nano_cpus=policy.nano_cpus,
                    mem_limit=policy.memory_bytes,
                    memswap_limit=policy.memory_swap_bytes,
                    pids_limit=policy.pids_limit,
                    volumes=volumes,
                    tmpfs=tmpfs,
                    environment=dict(spec.environment),
                    labels=dict(spec.labels),
                )
                removal_target = container
                container_id = container.id if _CONTAINER_ID.fullmatch(container.id) else None
                if container_id is None:
                    raise ContainerFactoryError("created container ID is malformed")
            except Exception as error:
                failure_phase = "create"
                raise ContainerFactoryError(str(error)) from error

            stdout: bytes | None = None
            stderr: bytes | None = None
            exit_code: int | None = None
            timed_out = False
            active_errors: list[str] = []
            try:
                wait_result = container.wait(timeout=policy.timeout_seconds)
                status_value = wait_result.get("StatusCode")
                if isinstance(status_value, bool) or not isinstance(status_value, int):
                    active_errors.append("container wait status is unavailable")
                else:
                    exit_code = status_value
                stdout_value = container.logs(stderr=False, stdout=True)
                stderr_value = container.logs(stderr=True, stdout=False)
                stdout = stdout_value.encode() if isinstance(stdout_value, str) else stdout_value
                stderr = stderr_value.encode() if isinstance(stderr_value, str) else stderr_value
            except Exception as error:
                timed_out = isinstance(error, TimeoutError) or "timeout" in type(error).__name__.lower()
                active_errors.append(f"{type(error).__name__}: {error}")
            duration_ms = (
                max(self._monotonic_ms() - probe_started_ms, 0)
                if probe_started_ms is not None
                else 0
            )
            active_evidence = _active_probe_evidence(
                spec,
                stdout=stdout,
                stderr=stderr,
                exit_code=exit_code,
                timed_out=timed_out,
                duration_ms=duration_ms,
                initial_errors=tuple(active_errors),
            )
            if active_evidence.status != "pass":
                failure_phase = "active_probe"
                raise ContainerFactoryError("active probe hard gates failed")

            try:
                inspected = self._client.containers.get(container.id)
                removal_target = inspected
                if inspected.attrs.get("Image") != policy.image_id:
                    errors.append("container image differs from the candidate")
                inspect_evidence, inspect_errors = _runtime_inspect(inspected, spec)
                errors.extend(inspect_errors)
                actual_image_reference = inspected.attrs.get("Image")
                if isinstance(actual_image_reference, str):
                    runtime_image = self._client.images.get(actual_image_reference)
                    runtime_image_evidence = _image_evidence(runtime_image, policy.image_id)
                    if runtime_image_evidence != image_evidence:
                        errors.append("runtime image evidence drifted after create")
                    image_evidence = runtime_image_evidence
                else:
                    errors.append("container image reference is unavailable")
                if errors:
                    raise ContainerFactoryError("runtime inspect hard gates failed")
            except Exception as error:
                failure_phase = "runtime_inspect"
                raise ContainerFactoryError(str(error)) from error
            execution_passed = True
        except Exception as error:
            errors.append(f"{type(error).__name__}: {error}")
        finally:
            if removal_target is not None:
                container_removal_attempted = True
                try:
                    removal_target.remove(force=True)
                    container_removed = True
                except Exception as error:
                    cleanup_errors.append(
                        f"container removal: {type(error).__name__}: {error}"
                    )
            for volume in reversed(created_volumes):
                try:
                    volume.remove(force=True)
                    removed_volume_names.append(volume.name)
                except Exception as error:
                    cleanup_errors.append(
                        f"volume removal {volume.name}: {type(error).__name__}: {error}"
                    )

            residual_container_ids: tuple[str, ...] = ()
            residual_volume_names: tuple[str, ...] = ()
            labels = spec.labels if spec is not None else {
                _MANAGED_LABEL: "true",
                _OPERATION_LABEL: request.operation_id,
                _CANDIDATE_LABEL: request.candidate_id,
                _ROLE_LABEL: role,
            }
            filters = _resource_filters(labels)
            try:
                residual_containers = self._client.containers.list(
                    all=True,
                    filters=filters,
                )
                residual_container_ids = tuple(
                    sorted(
                        container.id
                        for container in residual_containers
                        if _CONTAINER_ID.fullmatch(container.id)
                    )
                )
                if residual_containers and len(residual_container_ids) != len(residual_containers):
                    cleanup_errors.append("residual container ID is malformed")
            except Exception as error:
                cleanup_errors.append(
                    f"residual container audit: {type(error).__name__}: {error}"
                )
            try:
                residual_volumes = self._client.volumes.list(filters=filters)
                residual_volume_names = tuple(
                    sorted(volume.name for volume in residual_volumes)
                )
            except Exception as error:
                cleanup_errors.append(
                    f"residual volume audit: {type(error).__name__}: {error}"
                )

        created_volume_names = tuple(sorted(volume.name for volume in created_volumes))
        removed_names = tuple(sorted(removed_volume_names))
        cleanup = CleanupEvidence(
            container_removal_attempted=container_removal_attempted,
            container_removed=container_removed,
            created_volume_names=created_volume_names,
            removed_volume_names=removed_names,
            residual_container_ids=residual_container_ids,
            residual_volume_names=residual_volume_names,
            errors=tuple(cleanup_errors),
        )
        cleanup_passed = (
            cleanup.container_removal_attempted
            and cleanup.container_removed
            and cleanup.created_volume_names == cleanup.removed_volume_names
            and not cleanup.residual_container_ids
            and not cleanup.residual_volume_names
            and not cleanup.errors
        )
        if execution_passed and not cleanup_passed:
            if cleanup.errors:
                failure_phase = "cleanup"
            else:
                failure_phase = "residual_audit"
        errors.extend(cleanup.errors)
        if cleanup.residual_container_ids:
            errors.append("residual managed containers remain")
        if cleanup.residual_volume_names:
            errors.append("residual managed volumes remain")
        passed = execution_passed and cleanup_passed and not errors
        if passed:
            failure_phase = None
        elif failure_phase is None:
            failure_phase = "cleanup"
        return RoleFactoryEvidence(
            role=role,
            status="pass" if passed else "fail",
            failure_phase=failure_phase,
            container_id=container_id,
            expected_image_id=policy.image_id,
            actual_image_id=image_evidence.image_id,
            expected_platform="linux/amd64",
            actual_platform=image_evidence.platform,
            expected_provenance_sha256=policy.provenance_sha256,
            actual_provenance_sha256=image_evidence.provenance_sha256,
            inspect=inspect_evidence,
            active_probe=active_evidence,
            cleanup=cleanup,
            errors=tuple(errors),
        )
