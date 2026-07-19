from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Mapping, Protocol
from uuid import uuid4


ALPINE_PROBE_IMAGE = (
    "alpine@sha256:"
    "d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
)
BASE_IMAGE_REFERENCES = {
    "controller": (
        "python:3.11.14-slim-bookworm@sha256:"
        "65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d"
    ),
    "orchestrator": (
        "mirror.gcr.io/library/node@sha256:"
        "a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd"
    ),
}
RESOURCE_PREFIX = "repofixlab-bootstrap-doctor-"
RESOURCE_LABELS = {
    "io.repofixlab.owner": "bootstrap-doctor",
    "io.repofixlab.temporary": "true",
    "io.repofixlab.schema-version": "v1",
}
ROLE_SERVICES = {
    "controller": "controller",
    "orchestrator": "orchestrator",
    "dataset_preparer": "dataset-preparer",
    "worker": "worker",
    "evaluator": "evaluator",
}
BOOTSTRAP_SOCKET_ROLES = ("controller", "orchestrator")
DOCKER_SOCKET_PATHS = {"/var/run/docker.sock", "/run/docker.sock"}
IMAGE_COMPOSE_CONFIG_LABEL = "io.repofixlab.compose-config-sha256"
SHA256_HEX_PATTERN = re.compile(r"^[a-f0-9]{64}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[a-f0-9]{64}$")
REPOSITORY_DIGEST_PATTERN = re.compile(r"^[^\s@]+@sha256:[a-f0-9]{64}$")


class ContainerProtocol(Protocol):
    id: str
    name: str
    attrs: Mapping[str, object]

    def logs(self, *, stderr: bool = True, stdout: bool = True) -> bytes | str: ...

    def remove(self, *, force: bool = False) -> None: ...

    def wait(self, *, timeout: int | None = None) -> Mapping[str, object]: ...


class ContainerCollectionProtocol(Protocol):
    def get(self, container_id: str) -> ContainerProtocol: ...

    def run(
        self,
        image: str,
        command: list[str],
        **kwargs: object,
    ) -> ContainerProtocol: ...

    def list(
        self,
        *,
        all: bool = False,
        filters: Mapping[str, object] | None = None,
    ) -> list[ContainerProtocol]: ...


class VolumeProtocol(Protocol):
    name: str

    def remove(self, *, force: bool = False) -> None: ...


class VolumeCollectionProtocol(Protocol):
    def create(self, *, name: str, labels: Mapping[str, str]) -> VolumeProtocol: ...

    def list(self, *, filters: Mapping[str, object] | None = None) -> list[VolumeProtocol]: ...


class NetworkProtocol(Protocol):
    attrs: Mapping[str, object]


class NetworkCollectionProtocol(Protocol):
    def get(self, network_id: str) -> NetworkProtocol: ...


class ImageProtocol(Protocol):
    id: str
    attrs: Mapping[str, object]


class ImageCollectionProtocol(Protocol):
    def get(self, name: str) -> ImageProtocol: ...


class DockerClientProtocol(Protocol):
    containers: ContainerCollectionProtocol
    images: ImageCollectionProtocol
    networks: NetworkCollectionProtocol
    volumes: VolumeCollectionProtocol

    def info(self) -> Mapping[str, object]: ...

    def ping(self) -> bool: ...


@dataclass(frozen=True)
class NetworkObservation:
    network_id: str
    compose_project: str | None
    compose_network: str | None
    internal: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "network_id": self.network_id,
            "compose_project": self.compose_project,
            "compose_network": self.compose_network,
            "internal": self.internal,
        }


@dataclass(frozen=True)
class BaseImageObservation:
    image_id: str
    platform: str
    repository_digests: tuple[str, ...]
    rootfs_layers: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "image_id": self.image_id,
            "platform": self.platform,
            "repository_digests": list(self.repository_digests),
            "rootfs_layers": list(self.rootfs_layers),
        }


@dataclass(frozen=True)
class ServiceImageObservation:
    container_id: str
    image_id: str
    platform: str
    compose_project: str | None
    compose_service: str | None
    compose_config_sha256: str | None
    published_ports: tuple[str, ...]
    networks: tuple[NetworkObservation, ...]
    image_rootfs_layers: tuple[str, ...]
    base_image: BaseImageObservation

    def to_dict(self) -> dict[str, object]:
        return {
            "container_id": self.container_id,
            "image_id": self.image_id,
            "platform": self.platform,
            "compose_project": self.compose_project,
            "compose_service": self.compose_service,
            "compose_config_sha256": self.compose_config_sha256,
            "published_ports": list(self.published_ports),
            "networks": [network.to_dict() for network in self.networks],
            "image_rootfs_layers": list(self.image_rootfs_layers),
            "base_image": self.base_image.to_dict(),
        }


@dataclass(frozen=True)
class ImageProvenanceObservation:
    services: Mapping[str, ServiceImageObservation | None]

    def to_dict(self) -> dict[str, object]:
        return {
            "services": {
                service: observation.to_dict() if observation is not None else None
                for service, observation in self.services.items()
            }
        }


@dataclass(frozen=True)
class BootstrapHealth:
    daemon_reachable: bool
    server_version: str | None
    os_type: str | None
    architecture: str | None
    cpu_count: int | None
    memory_bytes: int | None
    docker_root_dir: str | None
    docker_volume_available_bytes: int | None
    docker_volume_id: str | None
    probe_image_digest: str
    control_network_internal: bool | None
    socket_topology: Mapping[str, str | None]
    image_provenance: ImageProvenanceObservation
    errors: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": "v1",
            "response_type": "controller_bootstrap_health",
            "daemon_reachable": self.daemon_reachable,
            "server_version": self.server_version,
            "os_type": self.os_type,
            "architecture": self.architecture,
            "cpu_count": self.cpu_count,
            "memory_bytes": str(self.memory_bytes) if self.memory_bytes is not None else None,
            "docker_root_dir": self.docker_root_dir,
            "docker_volume_available_bytes": (
                str(self.docker_volume_available_bytes)
                if self.docker_volume_available_bytes is not None
                else None
            ),
            "docker_volume_id": self.docker_volume_id,
            "probe_image_digest": self.probe_image_digest,
            "control_network_internal": self.control_network_internal,
            "socket_topology": dict(self.socket_topology),
            "image_provenance": self.image_provenance.to_dict(),
            "errors": list(self.errors),
        }


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _optional_non_negative_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _decode_logs(value: bytes | str) -> str:
    return value.decode("utf-8", errors="strict") if isinstance(value, bytes) else value


def _exit_code(wait_result: Mapping[str, object]) -> int | None:
    value = wait_result.get("StatusCode")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _remove_container(container: ContainerProtocol, resource_name: str, errors: list[str]) -> bool:
    try:
        container.remove(force=True)
        return True
    except Exception as error:  # Docker SDK errors are provider-specific.
        errors.append(f"cleanup container {resource_name}: {type(error).__name__}: {error}")
        return False


def _remove_volume(volume: VolumeProtocol, resource_name: str, errors: list[str]) -> bool:
    try:
        volume.remove(force=True)
        return True
    except Exception as error:  # Docker SDK errors are provider-specific.
        errors.append(f"cleanup volume {resource_name}: {type(error).__name__}: {error}")
        return False


def _container_name(kind: str, suffix: str) -> str:
    return f"{RESOURCE_PREFIX}{kind}-{suffix}"


def _temporary_resource_filters() -> Mapping[str, object]:
    return {
        "label": [
            "io.repofixlab.owner=bootstrap-doctor",
            "io.repofixlab.temporary=true",
        ]
    }


def _reconcile_stale_resources(client: DockerClientProtocol, errors: list[str]) -> None:
    try:
        containers = client.containers.list(all=True, filters=_temporary_resource_filters())
    except Exception as error:
        errors.append(f"list stale containers: {type(error).__name__}: {error}")
        containers = []
    for container in containers:
        if not container.name.startswith(RESOURCE_PREFIX):
            errors.append(f"refused stale container outside prefix: {container.name}")
            continue
        _remove_container(container, container.name, errors)

    try:
        volumes = client.volumes.list(filters=_temporary_resource_filters())
    except Exception as error:
        errors.append(f"list stale volumes: {type(error).__name__}: {error}")
        volumes = []
    for volume in volumes:
        if not volume.name.startswith(RESOURCE_PREFIX):
            errors.append(f"refused stale volume outside prefix: {volume.name}")
            continue
        _remove_volume(volume, volume.name, errors)


def _run_probe_container(
    client: DockerClientProtocol,
    *,
    command: list[str],
    name: str,
    volumes: Mapping[str, Mapping[str, str]] | None = None,
) -> ContainerProtocol:
    options: dict[str, object] = {
        "name": name,
        "detach": True,
        "remove": False,
        "network_mode": "none",
        "read_only": True,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "nano_cpus": 250_000_000,
        "mem_limit": "64m",
        "memswap_limit": "64m",
        "pids_limit": 64,
        "labels": RESOURCE_LABELS,
    }
    if volumes is not None:
        options["volumes"] = volumes
    return client.containers.run(ALPINE_PROBE_IMAGE, command, **options)


def _probe_managed_volume(
    client: DockerClientProtocol,
    suffix: str,
    errors: list[str],
) -> tuple[int | None, str | None, bool]:
    volume_name = _container_name("volume", suffix)
    container_name = _container_name("statfs", suffix)
    volume: VolumeProtocol | None = None
    container: ContainerProtocol | None = None
    available_bytes: int | None = None
    cleanup_ok = True
    try:
        volume = client.volumes.create(name=volume_name, labels=RESOURCE_LABELS)
        container = _run_probe_container(
            client,
            name=container_name,
            command=["stat", "-f", "-c", "%S %a", "/probe"],
            volumes={volume.name: {"bind": "/probe", "mode": "rw"}},
        )
        wait_result = container.wait(timeout=30)
        status_code = _exit_code(wait_result)
        output = _decode_logs(container.logs()).strip()
        if status_code != 0:
            raise RuntimeError(f"statfs probe exited with status {status_code}: {output}")
        fields = output.split()
        if len(fields) != 2 or not all(field.isdecimal() for field in fields):
            raise RuntimeError(f"invalid statfs output: {output!r}")
        block_size, available_blocks = (int(field) for field in fields)
        if block_size <= 0:
            raise RuntimeError("statfs block size must be positive")
        available_bytes = block_size * available_blocks
    except Exception as error:  # Preserve a partial health report for fail-closed evaluation.
        errors.append(f"managed volume statfs: {type(error).__name__}: {error}")
    finally:
        if container is not None:
            cleanup_ok = _remove_container(container, container_name, errors) and cleanup_ok
        if volume is not None:
            cleanup_ok = _remove_volume(volume, volume_name, errors) and cleanup_ok
    if not cleanup_ok:
        available_bytes = None
    return available_bytes, volume.name if volume is not None else None, volume is not None and cleanup_ok


def _compose_role_containers(
    client: DockerClientProtocol,
    role: str,
    compose_project: str,
) -> list[ContainerProtocol]:
    service = ROLE_SERVICES[role]
    candidates = client.containers.list(
        all=True,
        filters={
            "label": [
                f"com.docker.compose.project={compose_project}",
                f"com.docker.compose.service={service}",
            ]
        },
    )
    return [client.containers.get(container.id) for container in candidates]


def _socket_access_from_inspect(container: ContainerProtocol) -> str | None:
    mounts = container.attrs.get("Mounts")
    if not isinstance(mounts, list):
        return None
    matching_access: list[str] = []
    for mount in mounts:
        if not isinstance(mount, Mapping):
            return None
        source = mount.get("Source")
        destination = mount.get("Destination")
        if source not in DOCKER_SOCKET_PATHS and destination not in DOCKER_SOCKET_PATHS:
            continue
        read_write = mount.get("RW")
        if read_write is True:
            matching_access.append("read-write")
        elif read_write is False:
            matching_access.append("read-only")
        else:
            return None
    if not matching_access:
        return "none"
    return matching_access[0] if all(value == matching_access[0] for value in matching_access) else None


def _inspect_role_socket(
    client: DockerClientProtocol,
    role: str,
    compose_project: str,
    errors: list[str],
) -> str | None:
    try:
        containers = _compose_role_containers(client, role, compose_project)
        if not containers:
            raise RuntimeError("no matching Compose container exists")
        values = [_socket_access_from_inspect(container) for container in containers]
        if any(value is None for value in values) or any(value != values[0] for value in values):
            raise RuntimeError(f"ambiguous Docker socket mounts: {values}")
        return values[0]
    except Exception as error:  # Absent or ambiguous roles remain unknown and fail closed.
        errors.append(f"{role} socket inspection: {type(error).__name__}: {error}")
        return None


def _inspect_control_network(
    client: DockerClientProtocol,
    compose_project: str,
    errors: list[str],
) -> bool | None:
    try:
        containers = _compose_role_containers(client, "controller", compose_project)
        if len(containers) != 1:
            raise RuntimeError(f"expected one Controller container, found {len(containers)}")
        network_settings = containers[0].attrs.get("NetworkSettings")
        if not isinstance(network_settings, Mapping):
            raise RuntimeError("Controller NetworkSettings are unavailable")

        published_ports = network_settings.get("Ports")
        if not isinstance(published_ports, Mapping):
            raise RuntimeError("Controller published-port state is unavailable")
        if any(bindings not in (None, []) for bindings in published_ports.values()):
            raise RuntimeError("Controller publishes a host port")
        host_config = containers[0].attrs.get("HostConfig")
        if not isinstance(host_config, Mapping):
            raise RuntimeError("Controller HostConfig is unavailable")
        port_bindings = host_config.get("PortBindings")
        if port_bindings not in (None, {}):
            raise RuntimeError("Controller HostConfig contains port bindings")

        attachments = network_settings.get("Networks")
        if not isinstance(attachments, Mapping) or not attachments:
            raise RuntimeError("Controller has no inspectable networks")
        if len(attachments) != 1:
            raise RuntimeError(f"Controller must have exactly one network, found {len(attachments)}")
        internal_values: list[bool] = []
        for attachment in attachments.values():
            if not isinstance(attachment, Mapping):
                raise RuntimeError("Controller network attachment is malformed")
            network_id = attachment.get("NetworkID")
            if not isinstance(network_id, str) or not network_id:
                raise RuntimeError("Controller network ID is unavailable")
            internal = client.networks.get(network_id).attrs.get("Internal")
            if not isinstance(internal, bool):
                raise RuntimeError(f"Network {network_id} has no boolean Internal flag")
            internal_values.append(internal)
        return all(internal_values)
    except Exception as error:
        errors.append(f"control network inspection: {type(error).__name__}: {error}")
        return None


def _required_string(value: object, description: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{description} is unavailable")
    return value


def _optional_label(labels: Mapping[str, object], name: str) -> str | None:
    value = labels.get(name)
    return value if isinstance(value, str) and value else None


def _image_compose_config_sha256(
    image: ImageProtocol,
    service: str,
    errors: list[str],
) -> str | None:
    config = image.attrs.get("Config")
    if not isinstance(config, Mapping):
        errors.append(f"{service} running image Config is unavailable")
        return None
    labels_value = config.get("Labels")
    if labels_value is None:
        labels: Mapping[str, object] = {}
    elif isinstance(labels_value, Mapping):
        labels = labels_value
    else:
        errors.append(f"{service} running image labels are malformed")
        return None
    value = labels.get(IMAGE_COMPOSE_CONFIG_LABEL)
    if value is None:
        errors.append(
            f"{service} running image label {IMAGE_COMPOSE_CONFIG_LABEL} is missing"
        )
        return None
    if not isinstance(value, str) or SHA256_HEX_PATTERN.fullmatch(value) is None:
        errors.append(
            f"{service} running image label {IMAGE_COMPOSE_CONFIG_LABEL} is not a SHA-256"
        )
        return None
    return value


def _image_id(image: ImageProtocol, description: str) -> str:
    image_id = _required_string(image.attrs.get("Id"), f"{description} image ID")
    if IMAGE_ID_PATTERN.fullmatch(image_id) is None:
        raise RuntimeError(f"{description} image ID is malformed")
    if image.id != image_id:
        raise RuntimeError(f"{description} image object and inspect IDs differ")
    return image_id


def _image_platform(image: ImageProtocol, description: str) -> str:
    os_name = _required_string(image.attrs.get("Os"), f"{description} image OS")
    architecture = _required_string(
        image.attrs.get("Architecture"),
        f"{description} image architecture",
    )
    platform = f"{os_name}/{architecture}"
    if platform != "linux/amd64":
        raise RuntimeError(f"{description} image platform is {platform}, expected linux/amd64 evidence")
    return platform


def _image_rootfs_layers(image: ImageProtocol, description: str) -> tuple[str, ...]:
    rootfs = image.attrs.get("RootFS")
    if not isinstance(rootfs, Mapping):
        raise RuntimeError(f"{description} image RootFS is unavailable")
    layers = rootfs.get("Layers")
    if not isinstance(layers, list) or not layers:
        raise RuntimeError(f"{description} image RootFS layers are unavailable")
    if any(
        not isinstance(layer, str) or IMAGE_ID_PATTERN.fullmatch(layer) is None
        for layer in layers
    ):
        raise RuntimeError(f"{description} image RootFS layers are malformed")
    return tuple(layers)


def _repository_digests(image: ImageProtocol, description: str) -> tuple[str, ...]:
    digests = image.attrs.get("RepoDigests")
    if digests is None:
        return ()
    if not isinstance(digests, list) or any(
        not isinstance(digest, str) or REPOSITORY_DIGEST_PATTERN.fullmatch(digest) is None
        for digest in digests
    ):
        raise RuntimeError(f"{description} image repository digests are malformed")
    return tuple(sorted(digests))


def _render_port_bindings(
    port_map: Mapping[object, object],
    description: str,
) -> list[str]:
    published: list[str] = []
    for container_port, bindings in port_map.items():
        if not isinstance(container_port, str) or not container_port:
            raise RuntimeError(f"{description} container port key is malformed")
        if bindings in (None, []):
            continue
        if not isinstance(bindings, list):
            raise RuntimeError(f"{description} bindings for {container_port} are malformed")
        for binding in bindings:
            if not isinstance(binding, Mapping):
                raise RuntimeError(f"{description} binding for {container_port} is malformed")
            host_ip_value = binding.get("HostIp")
            host_port = binding.get("HostPort")
            if host_ip_value is not None and not isinstance(host_ip_value, str):
                raise RuntimeError(f"{description} host IP for {container_port} is malformed")
            if not isinstance(host_port, str) or not host_port:
                raise RuntimeError(f"{description} host port for {container_port} is malformed")
            host_ip = host_ip_value or "0.0.0.0"
            rendered_host_ip = f"[{host_ip}]" if ":" in host_ip else host_ip
            published.append(f"{rendered_host_ip}:{host_port}->{container_port}")
    return published


def _published_ports(container: ContainerProtocol) -> tuple[str, ...]:
    network_settings = container.attrs.get("NetworkSettings")
    if not isinstance(network_settings, Mapping):
        raise RuntimeError("container NetworkSettings are unavailable")
    network_ports = network_settings.get("Ports")
    if not isinstance(network_ports, Mapping):
        raise RuntimeError("container published-port state is unavailable")
    host_config = container.attrs.get("HostConfig")
    if not isinstance(host_config, Mapping):
        raise RuntimeError("container HostConfig is unavailable")
    host_ports_value = host_config.get("PortBindings")
    if host_ports_value is None:
        host_ports: Mapping[object, object] = {}
    elif isinstance(host_ports_value, Mapping):
        host_ports = host_ports_value
    else:
        raise RuntimeError("container HostConfig port bindings are malformed")
    published = _render_port_bindings(network_ports, "NetworkSettings")
    published.extend(_render_port_bindings(host_ports, "HostConfig"))
    return tuple(sorted(set(published)))


def _network_observations(
    client: DockerClientProtocol,
    container: ContainerProtocol,
) -> tuple[NetworkObservation, ...]:
    network_settings = container.attrs.get("NetworkSettings")
    if not isinstance(network_settings, Mapping):
        raise RuntimeError("container NetworkSettings are unavailable")
    attachments = network_settings.get("Networks")
    if not isinstance(attachments, Mapping):
        raise RuntimeError("container network attachments are unavailable")
    observations: list[NetworkObservation] = []
    for attachment_name, attachment in attachments.items():
        if not isinstance(attachment_name, str) or not attachment_name:
            raise RuntimeError("container network attachment name is malformed")
        if not isinstance(attachment, Mapping):
            raise RuntimeError(f"network attachment {attachment_name} is malformed")
        attached_network_id = _required_string(
            attachment.get("NetworkID"),
            f"network attachment {attachment_name} ID",
        )
        network = client.networks.get(attached_network_id)
        network_id = _required_string(network.attrs.get("Id"), f"network {attachment_name} ID")
        if SHA256_HEX_PATTERN.fullmatch(network_id) is None:
            raise RuntimeError(f"network {attachment_name} ID is malformed")
        if network_id != attached_network_id:
            raise RuntimeError(f"network attachment {attachment_name} and inspect IDs differ")
        internal = network.attrs.get("Internal")
        if not isinstance(internal, bool):
            raise RuntimeError(f"network {network_id} Internal flag is unavailable")
        labels_value = network.attrs.get("Labels")
        if labels_value is None:
            labels: Mapping[str, object] = {}
        elif isinstance(labels_value, Mapping):
            labels = labels_value
        else:
            raise RuntimeError(f"network {network_id} labels are malformed")
        observations.append(
            NetworkObservation(
                network_id=network_id,
                compose_project=_optional_label(labels, "com.docker.compose.project"),
                compose_network=_optional_label(labels, "com.docker.compose.network"),
                internal=internal,
            )
        )
    return tuple(
        sorted(
            observations,
            key=lambda observation: (
                observation.compose_network or "",
                observation.network_id,
            ),
        )
    )


def _base_image_observation(
    client: DockerClientProtocol,
    service: str,
) -> BaseImageObservation:
    base_image = client.images.get(BASE_IMAGE_REFERENCES[service])
    return BaseImageObservation(
        image_id=_image_id(base_image, f"{service} base"),
        platform=_image_platform(base_image, f"{service} base"),
        repository_digests=_repository_digests(base_image, f"{service} base"),
        rootfs_layers=_image_rootfs_layers(base_image, f"{service} base"),
    )


def _inspect_service_image_provenance(
    client: DockerClientProtocol,
    service: str,
    compose_project: str,
    errors: list[str],
) -> ServiceImageObservation:
    containers = _compose_role_containers(client, service, compose_project)
    if len(containers) != 1:
        raise RuntimeError(f"expected one Compose container, found {len(containers)}")
    container = containers[0]
    container_id = _required_string(container.id, f"{service} container ID")
    if SHA256_HEX_PATTERN.fullmatch(container_id) is None:
        raise RuntimeError(f"{service} container ID is malformed")
    running_image_reference = _required_string(
        container.attrs.get("Image"),
        f"{service} running image reference",
    )
    running_image = client.images.get(running_image_reference)
    running_image_id = _image_id(running_image, f"{service} running")
    if running_image_id != running_image_reference:
        raise RuntimeError(f"{service} container and inspected running image IDs differ")

    config = container.attrs.get("Config")
    if not isinstance(config, Mapping):
        raise RuntimeError(f"{service} container Config is unavailable")
    labels_value = config.get("Labels")
    if labels_value is None:
        labels: Mapping[str, object] = {}
    elif isinstance(labels_value, Mapping):
        labels = labels_value
    else:
        raise RuntimeError(f"{service} container labels are malformed")

    return ServiceImageObservation(
        container_id=container_id,
        image_id=running_image_id,
        platform=_image_platform(running_image, f"{service} running"),
        compose_project=_optional_label(labels, "com.docker.compose.project"),
        compose_service=_optional_label(labels, "com.docker.compose.service"),
        compose_config_sha256=_image_compose_config_sha256(
            running_image,
            service,
            errors,
        ),
        published_ports=_published_ports(container),
        networks=_network_observations(client, container),
        image_rootfs_layers=_image_rootfs_layers(running_image, f"{service} running"),
        base_image=_base_image_observation(client, service),
    )


def _collect_image_provenance(
    client: DockerClientProtocol,
    compose_project: str,
    errors: list[str],
) -> ImageProvenanceObservation:
    services: dict[str, ServiceImageObservation | None] = {}
    for service in BASE_IMAGE_REFERENCES:
        try:
            services[service] = _inspect_service_image_provenance(
                client,
                service,
                compose_project,
                errors,
            )
        except Exception as error:
            errors.append(
                f"{service} image provenance inspection: {type(error).__name__}: {error}"
            )
            services[service] = None
    return ImageProvenanceObservation(services=services)


def unreachable_bootstrap_health(
    error: Exception,
) -> BootstrapHealth:
    return BootstrapHealth(
        daemon_reachable=False,
        server_version=None,
        os_type=None,
        architecture=None,
        cpu_count=None,
        memory_bytes=None,
        docker_root_dir=None,
        docker_volume_available_bytes=None,
        docker_volume_id=None,
        probe_image_digest=ALPINE_PROBE_IMAGE,
        control_network_internal=None,
        socket_topology={
            "controller": None,
            "orchestrator": None,
            "dataset_preparer": None,
            "worker": None,
            "evaluator": None,
        },
        image_provenance=ImageProvenanceObservation(
            services={
                "controller": None,
                "orchestrator": None,
            }
        ),
        errors=(
            f"Docker daemon: {type(error).__name__}: {error}",
            "controller image provenance inspection: unavailable because Docker daemon is unreachable",
            "orchestrator image provenance inspection: unavailable because Docker daemon is unreachable",
        ),
    )


def collect_bootstrap_health(
    client: DockerClientProtocol,
    *,
    compose_project: str = "repofixlab",
) -> BootstrapHealth:
    errors: list[str] = []
    try:
        if client.ping() is not True:
            raise RuntimeError("Docker ping did not return true")
        info = client.info()
    except Exception as error:
        return unreachable_bootstrap_health(error)

    suffix = uuid4().hex[:12]
    _reconcile_stale_resources(client, errors)
    available_bytes, volume_id, _controller_write_probe_ok = _probe_managed_volume(
        client,
        suffix,
        errors,
    )
    socket_topology: dict[str, str | None] = {role: None for role in ROLE_SERVICES}
    for role in BOOTSTRAP_SOCKET_ROLES:
        socket_topology[role] = _inspect_role_socket(
            client,
            role,
            compose_project,
            errors,
        )
    control_network_internal = _inspect_control_network(client, compose_project, errors)
    image_provenance = _collect_image_provenance(client, compose_project, errors)

    return BootstrapHealth(
        daemon_reachable=True,
        server_version=_optional_string(info.get("ServerVersion")),
        os_type=_optional_string(info.get("OSType")),
        architecture=_optional_string(info.get("Architecture")),
        cpu_count=_optional_non_negative_int(info.get("NCPU")),
        memory_bytes=_optional_non_negative_int(info.get("MemTotal")),
        docker_root_dir=_optional_string(info.get("DockerRootDir")),
        docker_volume_available_bytes=available_bytes,
        docker_volume_id=volume_id,
        probe_image_digest=ALPINE_PROBE_IMAGE,
        control_network_internal=control_network_internal,
        socket_topology=socket_topology,
        image_provenance=image_provenance,
        errors=tuple(errors),
    )
