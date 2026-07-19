from __future__ import annotations

import unittest
from collections.abc import Mapping
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from repofixlab_controller.collector import (  # noqa: E402
    ALPINE_PROBE_IMAGE,
    BASE_IMAGE_REFERENCES,
    IMAGE_COMPOSE_CONFIG_LABEL,
    RESOURCE_PREFIX,
    collect_bootstrap_health,
)


CONTROLLER_IMAGE_ID = f"sha256:{'1' * 64}"
ORCHESTRATOR_IMAGE_ID = f"sha256:{'2' * 64}"
DRIFTED_CONTROLLER_IMAGE_ID = f"sha256:{'0' * 64}"
CONTROLLER_BASE_IMAGE_ID = f"sha256:{'3' * 64}"
ORCHESTRATOR_BASE_IMAGE_ID = f"sha256:{'4' * 64}"
CONTROLLER_BASE_LAYER = f"sha256:{'a' * 64}"
ORCHESTRATOR_BASE_LAYER = f"sha256:{'b' * 64}"
INTERNAL_NETWORK_ID = "e" * 64
EGRESS_NETWORK_ID = "f" * 64
UNEXPECTED_NETWORK_ID = "0" * 64


class FakeContainer:
    def __init__(
        self,
        name: str,
        output: str = "",
        status_code: int = 0,
        remove_fails: bool = False,
        attrs: Mapping[str, object] | None = None,
        container_id: str | None = None,
    ):
        self.id = container_id or f"id-{name}"
        self.name = name
        self.output = output
        self.status_code = status_code
        self.remove_fails = remove_fails
        self.removed = False
        self.attrs = dict(attrs or {"Mounts": []})

    def logs(self, *, stderr: bool = True, stdout: bool = True) -> bytes:
        self.assert_log_flags = (stderr, stdout)
        return self.output.encode("utf-8")

    def remove(self, *, force: bool = False) -> None:
        if self.remove_fails:
            raise RuntimeError("remove failed")
        if force is not True:
            raise AssertionError("temporary container removal must be forced")
        self.removed = True

    def wait(self, *, timeout: int | None = None) -> Mapping[str, object]:
        if timeout != 30:
            raise AssertionError("probe timeout must be fixed")
        return {"StatusCode": self.status_code}


class FakeContainers:
    def __init__(
        self,
        *,
        extra_controller_network: bool = False,
        failing_role: str | None = None,
        image_drift: bool = False,
        published_controller_port: bool = False,
        same_label_dynamic_roles: bool = False,
        stale_resource: bool = False,
    ):
        self.extra_controller_network = extra_controller_network
        self.failing_role = failing_role
        self.image_drift = image_drift
        self.published_controller_port = published_controller_port
        self.same_label_dynamic_roles = same_label_dynamic_roles
        self.calls: list[tuple[str, list[str], dict[str, object]]] = []
        self.created: list[FakeContainer] = []
        self.get_calls: list[str] = []
        self.service_list_calls: list[str] = []
        self.inspected: dict[str, FakeContainer] = {}
        self.stale = [FakeContainer(f"{RESOURCE_PREFIX}stale-container")] if stale_resource else []

    def get(self, container_id: str) -> FakeContainer:
        self.get_calls.append(container_id)
        try:
            return self.inspected[container_id]
        except KeyError as error:
            raise AssertionError(f"unexpected container inspect ID: {container_id}") from error

    def list(
        self,
        *,
        all: bool = False,
        filters: Mapping[str, object] | None = None,
    ) -> list[FakeContainer]:
        if all is not True or filters is None:
            raise AssertionError("Compose inspection must include stopped containers and labels")
        labels = filters.get("label")
        if not isinstance(labels, list):
            raise AssertionError("Compose inspection labels are required")
        if "io.repofixlab.owner=bootstrap-doctor" in labels:
            return self.stale
        service_prefix = "com.docker.compose.service="
        services = [label.removeprefix(service_prefix) for label in labels if label.startswith(service_prefix)]
        if len(services) != 1:
            raise AssertionError("exactly one Compose service label is required")
        service = services[0]
        self.service_list_calls.append(service)
        if self.failing_role == service:
            return []
        if service in {"dataset-preparer", "worker", "evaluator"}:
            if not self.same_label_dynamic_roles:
                return []
            container = FakeContainer(
                f"same-label-{service}",
                attrs={
                    "Mounts": [
                        {
                            "Source": "/var/run/docker.sock",
                            "Destination": "/var/run/docker.sock",
                            "RW": True,
                        }
                    ],
                    "Config": {
                        "Labels": {
                            "com.docker.compose.project": "repofixlab",
                            "com.docker.compose.service": service,
                        }
                    },
                },
            )
            self.inspected[container.id] = container
            return [container]
        mounts = (
            [{"Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True}]
            if service == "controller"
            else []
        )
        service_image_ids = {
            "controller": (
                DRIFTED_CONTROLLER_IMAGE_ID if self.image_drift else CONTROLLER_IMAGE_ID
            ),
            "orchestrator": ORCHESTRATOR_IMAGE_ID,
        }
        attrs: dict[str, object] = {
            "Mounts": mounts,
        }
        if service in service_image_ids:
            networks: dict[str, object] = {
                "repofix-control": {"NetworkID": INTERNAL_NETWORK_ID},
            }
            if service == "orchestrator":
                networks["provider-egress"] = {"NetworkID": EGRESS_NETWORK_ID}
            bindings = (
                [{"HostIp": "0.0.0.0", "HostPort": "8000"}]
                if service == "controller" and self.published_controller_port
                else None
            )
            attrs.update(
                {
                    "Image": service_image_ids[service],
                    "Config": {
                        "Labels": {
                            "com.docker.compose.project": "repofixlab",
                            "com.docker.compose.service": service,
                            "com.docker.compose.config-hash": (
                                "9" * 64 if service == "controller" else "a" * 64
                            ),
                            "com.docker.compose.oneoff": (
                                "True" if service == "orchestrator" else "False"
                            ),
                        }
                    },
                    "NetworkSettings": {
                        "Networks": networks,
                        "Ports": {"8000/tcp": bindings} if service == "controller" else {},
                    },
                    "HostConfig": {"PortBindings": {}},
                }
            )
        if service == "controller":
            if self.extra_controller_network:
                network_settings = attrs["NetworkSettings"]
                assert isinstance(network_settings, dict)
                attached_networks = network_settings["Networks"]
                assert isinstance(attached_networks, dict)
                attached_networks["unexpected"] = {"NetworkID": UNEXPECTED_NETWORK_ID}
            attrs["HostConfig"] = {
                "PortBindings": {"8000/tcp": bindings} if bindings is not None else {},
            }
        container = FakeContainer(
            f"actual-{service}",
            attrs=attrs,
            container_id=("c" if service == "controller" else "d") * 64,
        )
        self.inspected[container.id] = container
        return [container]

    def run(
        self,
        image: str,
        command: list[str],
        **kwargs: object,
    ) -> FakeContainer:
        name_value = kwargs.get("name")
        if not isinstance(name_value, str):
            raise AssertionError("probe name is required")
        is_statfs = command[:2] == ["stat", "-f"]
        output = "4096 30000000" if is_statfs else "none"
        status_code = 0
        if self.failing_role is not None and f"socket-{self.failing_role}" in name_value:
            output = "present"
            status_code = 42
        container = FakeContainer(name_value, output, status_code)
        self.calls.append((image, command, kwargs))
        self.created.append(container)
        return container


class FakeVolume:
    def __init__(self, name: str, remove_fails: bool = False):
        self.name = name
        self.remove_fails = remove_fails
        self.removed = False

    def remove(self, *, force: bool = False) -> None:
        if self.remove_fails:
            raise RuntimeError("volume remove failed")
        if force is not True:
            raise AssertionError("temporary volume removal must be forced")
        self.removed = True


class FakeVolumes:
    def __init__(self, *, remove_fails: bool = False, stale_resource: bool = False):
        self.remove_fails = remove_fails
        self.created: list[FakeVolume] = []
        self.stale = [FakeVolume(f"{RESOURCE_PREFIX}stale-volume")] if stale_resource else []

    def create(self, *, name: str, labels: Mapping[str, str]) -> FakeVolume:
        if not name.startswith(RESOURCE_PREFIX):
            raise AssertionError("temporary volume must use the resource prefix")
        if labels.get("io.repofixlab.temporary") != "true":
            raise AssertionError("temporary volume label is required")
        volume = FakeVolume(name, self.remove_fails)
        self.created.append(volume)
        return volume

    def list(self, *, filters: Mapping[str, object] | None = None) -> list[FakeVolume]:
        if filters is None:
            raise AssertionError("stale volume labels are required")
        return self.stale


class FakeNetwork:
    def __init__(
        self,
        network_id: str,
        internal: bool,
        *,
        compose_network: str | None,
    ):
        labels = (
            {
                "com.docker.compose.project": "repofixlab",
                "com.docker.compose.network": compose_network,
            }
            if compose_network is not None
            else None
        )
        self.attrs = {
            "Id": network_id,
            "Internal": internal,
            "Labels": labels,
        }


class FakeNetworks:
    def __init__(self, internal: bool = True):
        self.internal = internal

    def get(self, network_id: str) -> FakeNetwork:
        if network_id == INTERNAL_NETWORK_ID:
            return FakeNetwork(
                network_id,
                self.internal,
                compose_network="repofix-control",
            )
        if network_id == EGRESS_NETWORK_ID:
            return FakeNetwork(
                network_id,
                False,
                compose_network="provider-egress",
            )
        if network_id == UNEXPECTED_NETWORK_ID:
            return FakeNetwork(network_id, False, compose_network=None)
        raise AssertionError(f"unexpected network ID: {network_id}")


class FakeImage:
    def __init__(
        self,
        image_id: str,
        *,
        compose_config_sha256: str | None = None,
        repository_digests: list[str] | None,
        rootfs_layers: list[str],
    ):
        self.id = image_id
        self.attrs = {
            "Id": image_id,
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {
                "Labels": (
                    {IMAGE_COMPOSE_CONFIG_LABEL: compose_config_sha256}
                    if compose_config_sha256 is not None
                    else {}
                )
            },
            "RepoDigests": repository_digests,
            "RootFS": {"Layers": rootfs_layers},
        }


class FakeImages:
    def __init__(
        self,
        *,
        controller_compose_config_sha256: str | None = "8" * 64,
        missing_base_service: str | None = None,
    ):
        self.controller_compose_config_sha256 = controller_compose_config_sha256
        self.missing_base_service = missing_base_service
        self.calls: list[str] = []

    def get(self, name: str) -> FakeImage:
        self.calls.append(name)
        if name == CONTROLLER_IMAGE_ID:
            return FakeImage(
                CONTROLLER_IMAGE_ID,
                compose_config_sha256=self.controller_compose_config_sha256,
                repository_digests=None,
                rootfs_layers=[CONTROLLER_BASE_LAYER, f"sha256:{'5' * 64}"],
            )
        if name == DRIFTED_CONTROLLER_IMAGE_ID:
            return FakeImage(
                DRIFTED_CONTROLLER_IMAGE_ID,
                compose_config_sha256=self.controller_compose_config_sha256,
                repository_digests=None,
                rootfs_layers=[CONTROLLER_BASE_LAYER, f"sha256:{'6' * 64}"],
            )
        if name == ORCHESTRATOR_IMAGE_ID:
            return FakeImage(
                ORCHESTRATOR_IMAGE_ID,
                compose_config_sha256="b" * 64,
                repository_digests=None,
                rootfs_layers=[ORCHESTRATOR_BASE_LAYER, f"sha256:{'7' * 64}"],
            )
        if name == BASE_IMAGE_REFERENCES["controller"]:
            if self.missing_base_service == "controller":
                raise RuntimeError("controller base image missing")
            return FakeImage(
                CONTROLLER_BASE_IMAGE_ID,
                repository_digests=[BASE_IMAGE_REFERENCES["controller"]],
                rootfs_layers=[CONTROLLER_BASE_LAYER],
            )
        if name == BASE_IMAGE_REFERENCES["orchestrator"]:
            if self.missing_base_service == "orchestrator":
                raise RuntimeError("orchestrator base image missing")
            return FakeImage(
                ORCHESTRATOR_BASE_IMAGE_ID,
                repository_digests=[BASE_IMAGE_REFERENCES["orchestrator"]],
                rootfs_layers=[ORCHESTRATOR_BASE_LAYER],
            )
        raise AssertionError(f"unexpected image reference: {name}")


class FakeDockerClient:
    def __init__(
        self,
        *,
        controller_compose_config_sha256: str | None = "8" * 64,
        extra_controller_network: bool = False,
        ping_result: bool = True,
        failing_role: str | None = None,
        image_drift: bool = False,
        internal_network: bool = True,
        missing_base_service: str | None = None,
        published_controller_port: bool = False,
        same_label_dynamic_roles: bool = False,
        stale_resources: bool = False,
        volume_remove_fails: bool = False,
    ):
        self.ping_result = ping_result
        self.containers = FakeContainers(
            extra_controller_network=extra_controller_network,
            failing_role=failing_role,
            image_drift=image_drift,
            published_controller_port=published_controller_port,
            same_label_dynamic_roles=same_label_dynamic_roles,
            stale_resource=stale_resources,
        )
        self.images = FakeImages(
            controller_compose_config_sha256=controller_compose_config_sha256,
            missing_base_service=missing_base_service,
        )
        self.networks = FakeNetworks(internal=internal_network)
        self.volumes = FakeVolumes(remove_fails=volume_remove_fails, stale_resource=stale_resources)

    def ping(self) -> bool:
        return self.ping_result

    def info(self) -> Mapping[str, object]:
        return {
            "ServerVersion": "29.3.1",
            "OSType": "linux",
            "Architecture": "x86_64",
            "NCPU": 8,
            "MemTotal": 17_179_869_184,
            "DockerRootDir": "/var/lib/docker",
        }


class CollectorTests(unittest.TestCase):
    def test_collects_daemon_resources_volume_statfs_and_socket_topology(self) -> None:
        client = FakeDockerClient()

        health = collect_bootstrap_health(client)

        self.assertTrue(health.daemon_reachable)
        self.assertEqual(health.server_version, "29.3.1")
        self.assertEqual(health.os_type, "linux")
        self.assertEqual(health.architecture, "x86_64")
        self.assertEqual(health.cpu_count, 8)
        self.assertEqual(health.memory_bytes, 17_179_869_184)
        self.assertEqual(health.docker_root_dir, "/var/lib/docker")
        self.assertEqual(health.docker_volume_available_bytes, 122_880_000_000)
        self.assertIsNotNone(health.docker_volume_id)
        self.assertEqual(health.probe_image_digest, ALPINE_PROBE_IMAGE)
        self.assertEqual(
            health.socket_topology,
            {
                "controller": "read-write",
                "orchestrator": "none",
                "dataset_preparer": None,
                "worker": None,
                "evaluator": None,
            },
        )
        self.assertTrue(health.control_network_internal)
        self.assertEqual(health.errors, ())
        self.assertEqual(
            health.to_dict(),
            {
                "schema_version": "v1",
                "response_type": "controller_bootstrap_health",
                "daemon_reachable": True,
                "server_version": "29.3.1",
                "os_type": "linux",
                "architecture": "x86_64",
                "cpu_count": 8,
                "memory_bytes": "17179869184",
                "docker_root_dir": "/var/lib/docker",
                "docker_volume_available_bytes": "122880000000",
                "docker_volume_id": health.docker_volume_id,
                "probe_image_digest": ALPINE_PROBE_IMAGE,
                "control_network_internal": True,
                "socket_topology": {
                    "controller": "read-write",
                    "orchestrator": "none",
                    "dataset_preparer": None,
                    "worker": None,
                    "evaluator": None,
                },
                "image_provenance": {
                    "services": {
                        "controller": {
                            "container_id": "c" * 64,
                            "image_id": CONTROLLER_IMAGE_ID,
                            "platform": "linux/amd64",
                            "compose_project": "repofixlab",
                            "compose_service": "controller",
                            "compose_config_sha256": "8" * 64,
                            "published_ports": [],
                            "networks": [
                                {
                                    "network_id": INTERNAL_NETWORK_ID,
                                    "compose_project": "repofixlab",
                                    "compose_network": "repofix-control",
                                    "internal": True,
                                }
                            ],
                            "image_rootfs_layers": [
                                CONTROLLER_BASE_LAYER,
                                f"sha256:{'5' * 64}",
                            ],
                            "base_image": {
                                "image_id": CONTROLLER_BASE_IMAGE_ID,
                                "platform": "linux/amd64",
                                "repository_digests": [BASE_IMAGE_REFERENCES["controller"]],
                                "rootfs_layers": [CONTROLLER_BASE_LAYER],
                            },
                        },
                        "orchestrator": {
                            "container_id": "d" * 64,
                            "image_id": ORCHESTRATOR_IMAGE_ID,
                            "platform": "linux/amd64",
                            "compose_project": "repofixlab",
                            "compose_service": "orchestrator",
                            "compose_config_sha256": "b" * 64,
                            "published_ports": [],
                            "networks": [
                                {
                                    "network_id": EGRESS_NETWORK_ID,
                                    "compose_project": "repofixlab",
                                    "compose_network": "provider-egress",
                                    "internal": False,
                                },
                                {
                                    "network_id": INTERNAL_NETWORK_ID,
                                    "compose_project": "repofixlab",
                                    "compose_network": "repofix-control",
                                    "internal": True,
                                },
                            ],
                            "image_rootfs_layers": [
                                ORCHESTRATOR_BASE_LAYER,
                                f"sha256:{'7' * 64}",
                            ],
                            "base_image": {
                                "image_id": ORCHESTRATOR_BASE_IMAGE_ID,
                                "platform": "linux/amd64",
                                "repository_digests": [BASE_IMAGE_REFERENCES["orchestrator"]],
                                "rootfs_layers": [ORCHESTRATOR_BASE_LAYER],
                            },
                        },
                    }
                },
                "errors": [],
            },
        )
        self.assertEqual(len(client.containers.calls), 1)
        self.assertIn("c" * 64, client.containers.get_calls)
        self.assertIn("d" * 64, client.containers.get_calls)
        self.assertTrue(all(container.removed for container in client.containers.created))
        self.assertTrue(all(volume.removed for volume in client.volumes.created))
        for image, _command, options in client.containers.calls:
            self.assertEqual(image, ALPINE_PROBE_IMAGE)
            self.assertTrue(str(options["name"]).startswith(RESOURCE_PREFIX))
            self.assertEqual(options["network_mode"], "none")
            self.assertEqual(options["cap_drop"], ["ALL"])
            self.assertEqual(options["security_opt"], ["no-new-privileges:true"])
            self.assertEqual(options["nano_cpus"], 250_000_000)
            self.assertEqual(options["mem_limit"], "64m")
            self.assertEqual(options["memswap_limit"], "64m")
            self.assertEqual(options["pids_limit"], 64)

    def test_records_image_drift_without_making_a_pass_fail_decision(self) -> None:
        health = collect_bootstrap_health(FakeDockerClient(image_drift=True))

        controller = health.image_provenance.services["controller"]
        self.assertIsNotNone(controller)
        assert controller is not None
        self.assertEqual(controller.image_id, DRIFTED_CONTROLLER_IMAGE_ID)
        self.assertEqual(
            controller.image_rootfs_layers,
            (CONTROLLER_BASE_LAYER, f"sha256:{'6' * 64}"),
        )
        self.assertEqual(health.errors, ())

    def test_observes_current_compose_orchestrator_one_off_container(self) -> None:
        client = FakeDockerClient()

        health = collect_bootstrap_health(client)

        orchestrator = health.image_provenance.services["orchestrator"]
        self.assertIsNotNone(orchestrator)
        assert orchestrator is not None
        self.assertEqual(orchestrator.compose_project, "repofixlab")
        self.assertEqual(orchestrator.compose_service, "orchestrator")
        self.assertEqual(orchestrator.compose_config_sha256, "b" * 64)
        one_off_container = client.containers.inspected["d" * 64]
        container_labels = one_off_container.attrs["Config"]
        assert isinstance(container_labels, dict)
        labels = container_labels["Labels"]
        assert isinstance(labels, dict)
        self.assertEqual(labels["com.docker.compose.config-hash"], "a" * 64)
        self.assertNotEqual(
            orchestrator.compose_config_sha256,
            labels["com.docker.compose.config-hash"],
        )
        self.assertIn(BASE_IMAGE_REFERENCES["orchestrator"], client.images.calls)

    def test_missing_image_compose_config_label_is_null_and_records_an_error(self) -> None:
        health = collect_bootstrap_health(
            FakeDockerClient(controller_compose_config_sha256=None)
        )

        controller = health.image_provenance.services["controller"]
        self.assertIsNotNone(controller)
        assert controller is not None
        self.assertIsNone(controller.compose_config_sha256)
        self.assertTrue(
            any(
                f"controller running image label {IMAGE_COMPOSE_CONFIG_LABEL} is missing"
                in error
                for error in health.errors
            )
        )

    def test_invalid_image_compose_config_label_is_null_and_records_an_error(self) -> None:
        health = collect_bootstrap_health(
            FakeDockerClient(controller_compose_config_sha256="A" * 64)
        )

        controller = health.image_provenance.services["controller"]
        self.assertIsNotNone(controller)
        assert controller is not None
        self.assertIsNone(controller.compose_config_sha256)
        self.assertTrue(
            any(
                f"controller running image label {IMAGE_COMPOSE_CONFIG_LABEL} is not a SHA-256"
                in error
                for error in health.errors
            )
        )

    def test_missing_provenance_service_is_null_and_records_an_error(self) -> None:
        health = collect_bootstrap_health(FakeDockerClient(failing_role="orchestrator"))

        self.assertIsNone(health.image_provenance.services["orchestrator"])
        self.assertIsNotNone(health.image_provenance.services["controller"])
        self.assertTrue(
            any("orchestrator image provenance inspection" in error for error in health.errors)
        )

    def test_missing_base_image_nulls_only_that_service_and_records_an_error(self) -> None:
        health = collect_bootstrap_health(
            FakeDockerClient(missing_base_service="controller")
        )

        self.assertIsNone(health.image_provenance.services["controller"])
        self.assertIsNotNone(health.image_provenance.services["orchestrator"])
        self.assertTrue(
            any(
                "controller image provenance inspection" in error
                and "base image missing" in error
                for error in health.errors
            )
        )

    def test_absent_deferred_roles_are_unknown_without_errors(self) -> None:
        client = FakeDockerClient()

        health = collect_bootstrap_health(client)

        for role in ("dataset_preparer", "worker", "evaluator"):
            self.assertIsNone(health.socket_topology[role])
            self.assertFalse(
                any(f"{role} socket inspection" in error for error in health.errors)
            )
        self.assertEqual(health.errors, ())
        self.assertTrue(all(container.removed for container in client.containers.created))
        self.assertTrue(all(volume.removed for volume in client.volumes.created))

    def test_missing_bootstrap_socket_role_records_an_error(self) -> None:
        for role in ("controller", "orchestrator"):
            with self.subTest(role=role):
                health = collect_bootstrap_health(FakeDockerClient(failing_role=role))

                self.assertIsNone(health.socket_topology[role])
                self.assertTrue(
                    any(f"{role} socket inspection" in error for error in health.errors)
                )

    def test_same_label_dynamic_roles_do_not_affect_bootstrap(self) -> None:
        client = FakeDockerClient(same_label_dynamic_roles=True)

        health = collect_bootstrap_health(client)

        self.assertEqual(
            {
                role: health.socket_topology[role]
                for role in ("dataset_preparer", "worker", "evaluator")
            },
            {"dataset_preparer": None, "worker": None, "evaluator": None},
        )
        self.assertEqual(health.errors, ())
        for service in ("dataset-preparer", "worker", "evaluator"):
            self.assertNotIn(service, client.containers.service_list_calls)

    def test_external_controller_network_is_reported_as_failure(self) -> None:
        health = collect_bootstrap_health(FakeDockerClient(internal_network=False))

        self.assertFalse(health.control_network_internal)

    def test_published_controller_port_invalidates_control_network_evidence(self) -> None:
        health = collect_bootstrap_health(FakeDockerClient(published_controller_port=True))

        self.assertIsNone(health.control_network_internal)
        self.assertTrue(any("publishes a host port" in error for error in health.errors))
        controller = health.image_provenance.services["controller"]
        self.assertIsNotNone(controller)
        assert controller is not None
        self.assertEqual(controller.published_ports, ("0.0.0.0:8000->8000/tcp",))

    def test_extra_controller_network_invalidates_control_network_evidence(self) -> None:
        health = collect_bootstrap_health(FakeDockerClient(extra_controller_network=True))

        self.assertIsNone(health.control_network_internal)
        self.assertTrue(any("exactly one network" in error for error in health.errors))
        controller = health.image_provenance.services["controller"]
        self.assertIsNotNone(controller)
        assert controller is not None
        self.assertEqual(
            controller.networks[0].to_dict(),
            {
                "network_id": UNEXPECTED_NETWORK_ID,
                "compose_project": None,
                "compose_network": None,
                "internal": False,
            },
        )

    def test_reconciles_stale_labeled_resources_before_probing(self) -> None:
        client = FakeDockerClient(stale_resources=True)

        collect_bootstrap_health(client)

        self.assertTrue(all(container.removed for container in client.containers.stale))
        self.assertTrue(all(volume.removed for volume in client.volumes.stale))

    def test_cleanup_failure_invalidates_volume_evidence(self) -> None:
        client = FakeDockerClient(volume_remove_fails=True)

        health = collect_bootstrap_health(client)

        self.assertIsNone(health.docker_volume_available_bytes)
        self.assertTrue(any("cleanup volume" in error for error in health.errors))

    def test_unreachable_daemon_returns_only_unknown_facts(self) -> None:
        client = FakeDockerClient(ping_result=False)

        health = collect_bootstrap_health(client)

        self.assertFalse(health.daemon_reachable)
        self.assertIsNone(health.server_version)
        self.assertIsNone(health.os_type)
        self.assertIsNone(health.docker_volume_available_bytes)
        self.assertTrue(all(value is None for value in health.socket_topology.values()))
        self.assertEqual(client.containers.calls, [])
        self.assertEqual(client.volumes.created, [])
        self.assertEqual(health.to_dict()["memory_bytes"], None)
        self.assertEqual(
            health.to_dict()["image_provenance"],
            {"services": {"controller": None, "orchestrator": None}},
        )
        self.assertTrue(
            any("controller image provenance inspection" in error for error in health.errors)
        )


if __name__ == "__main__":
    unittest.main()
