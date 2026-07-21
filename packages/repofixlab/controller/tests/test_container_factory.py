from __future__ import annotations

from dataclasses import replace
import hashlib
import inspect
import json
from collections.abc import Mapping
from pathlib import Path
import sys
import unittest

from jsonschema import Draft202012Validator


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PACKAGE_ROOT / "controller" / "src"))

from repofixlab_controller.container_factory import (  # noqa: E402
    AXIOS_SMOKE_BASE_COMMIT,
    AXIOS_SMOKE_INSTANCE_ID,
    IMAGE_PROVENANCE_LABEL,
    TASK_ROLE_FACTORY_PROBE_PROFILE,
    CandidateLaunchDefinition,
    ContainerFactoryError,
    ControllerExecutionEvidence,
    ControllerExecutionNetwork,
    ManagedVolumePolicy,
    ObservedMount,
    RoleContainerFactory,
    RoleLaunchPolicy,
    TmpfsPolicy,
    TrustedCandidateResolver,
    inspect_controller_execution,
    task_role_factory_probe_request_sha256,
)


WORKER_IMAGE_ID = (
    "sha256:40bb6384cf4cf6df8b090b8f4d4dc42e0644adc36bdb6b756af455b8b21de9bd"
)
EVALUATOR_IMAGE_ID = (
    "sha256:86618f5b824cb61e5cb5893ed856d71d816e4ddcbee921b021eb2c396d04da66"
)
DRIFTED_IMAGE_ID = "sha256:" + "3" * 64
WORKER_PROVENANCE = "dc193653e97deb89060d75bc7aa2f59701aa8ea462918547dc4511fd41808a26"
EVALUATOR_PROVENANCE = "e280b68d557aab18fb8bf87a0fff417b3efbf231a0dd7cda6e583dcf5ed4d4d6"
CANDIDATE_SHA256 = "6" * 64
PROBE_SHA256 = "f66942a1754e328c22677c2096fd3fe8523dff39e2bb4c403adcfb142d91b775"
SANITIZER_SHA256 = "68ef77f59b38239a3863f9cb1669ecf2f3270d3148191a2bc7010f66e20712f6"
WORKER_NONCE = "8" * 32
EVALUATOR_NONCE = "9" * 32
CONTROLLER_ID = "e" * 64
CONTROLLER_HOSTNAME = CONTROLLER_ID[:12]
CONTROLLER_IMAGE_ID = "sha256:" + "7" * 64
CONTROLLER_CONFIG_SHA256 = "4" * 64
CONTROL_NETWORK_ID = "5" * 64


def _controller_execution(
    socket_source: str = "/var/run/docker.sock",
) -> ControllerExecutionEvidence:
    return ControllerExecutionEvidence(
        container_hostname=CONTROLLER_HOSTNAME,
        container_id=CONTROLLER_ID,
        image_id=CONTROLLER_IMAGE_ID,
        compose_project="repofixlab",
        compose_service="controller",
        compose_config_sha256=CONTROLLER_CONFIG_SHA256,
        read_only_root_filesystem=True,
        cap_drop=("ALL",),
        security_opt=("no-new-privileges:true",),
        published_ports=(),
        networks=(
            ControllerExecutionNetwork(
                network_id=CONTROL_NETWORK_ID,
                compose_project="repofixlab",
                compose_network="repofix-control",
                internal=True,
            ),
        ),
        mounts=(
            ObservedMount(
                "bind",
                socket_source,
                "/var/run/docker.sock",
                True,
            ),
            ObservedMount("tmpfs", None, "/tmp", True),
            ObservedMount(
                "volume",
                "repofixlab_controller-work-v2",
                "/var/lib/repofix/controller",
                True,
            ),
            ObservedMount(
                "volume",
                "repofixlab_controller-candidates-v1",
                "/etc/repofixlab/candidates",
                False,
            ),
        ),
    )


def _canonical_hash(value: object) -> str:
    content = (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode()
    return hashlib.sha256(content).hexdigest()


def _policy(role: str) -> RoleLaunchPolicy:
    return RoleLaunchPolicy(
        image_id=WORKER_IMAGE_ID if role == "worker" else EVALUATOR_IMAGE_ID,
        provenance_sha256=(
            WORKER_PROVENANCE if role == "worker" else EVALUATOR_PROVENANCE
        ),
        command=("/opt/repofixlab/bin/active-probe",),
        user="65532:65532",
        nano_cpus=4_000_000_000,
        memory_bytes=256 * 1024 * 1024,
        memory_swap_bytes=256 * 1024 * 1024,
        pids_limit=128,
        timeout_seconds=60,
        managed_volumes=(ManagedVolumePolicy("testbed", "/testbed"),),
        tmpfs=(TmpfsPolicy("/tmp", "rw,noexec,nosuid,nodev,size=64m"),),
        allowed_image_environment_names=("PATH",),
    )


def _resolver() -> TrustedCandidateResolver:
    return TrustedCandidateResolver(
        {
            "candidate-1": CandidateLaunchDefinition(
                candidate_sha256=CANDIDATE_SHA256,
                instance_id=AXIOS_SMOKE_INSTANCE_ID,
                base_commit=AXIOS_SMOKE_BASE_COMMIT,
                probe_sha256=PROBE_SHA256,
                worker=_policy("worker"),
                evaluator=_policy("evaluator"),
            )
        }
    )


def _request(resolver: TrustedCandidateResolver):
    request_sha256 = task_role_factory_probe_request_sha256(
        operation_id="operation-1",
        candidate_id="candidate-1",
        candidate_sha256=CANDIDATE_SHA256,
    )
    return resolver.resolve_request(
        operation_id="operation-1",
        candidate_id="candidate-1",
        candidate_sha256=CANDIDATE_SHA256,
        request_sha256=request_sha256,
    )


class FakeImage:
    def __init__(
        self,
        image_id: str,
        provenance: str,
        *,
        platform: str = "amd64",
        object_id: str | None = None,
    ) -> None:
        self.id = object_id or image_id
        self.attrs = {
            "Id": image_id,
            "Os": "linux",
            "Architecture": platform,
            "Config": {
                "Env": [
                    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "TZ=Etc/UTC",
                    "CHROME_BIN=/usr/bin/google-chrome",
                    "CHROME_PATH=/usr/bin/google-chrome",
                    "HOME=/tmp/repofixlab-home",
                ],
                "Labels": {
                    "io.repofixlab.base-commit": AXIOS_SMOKE_BASE_COMMIT,
                    "io.repofixlab.instance-id": AXIOS_SMOKE_INSTANCE_ID,
                    IMAGE_PROVENANCE_LABEL: provenance,
                    "io.repofixlab.role-probe-sha256": PROBE_SHA256,
                    "io.repofixlab.sanitizer-sha256": SANITIZER_SHA256,
                },
            },
        }


class FakeImages:
    def __init__(self, events: list[str], failure: str | None) -> None:
        self.events = events
        self.failure = failure
        self.calls: list[str] = []

    def get(self, image_id: str) -> FakeImage:
        self.calls.append(image_id)
        role = "worker" if image_id == WORKER_IMAGE_ID else "evaluator"
        self.events.append(f"image.get:{role}")
        if self.failure == "image_get" and role == "worker":
            raise RuntimeError("injected image get failure")
        provenance = WORKER_PROVENANCE if role == "worker" else EVALUATOR_PROVENANCE
        if self.failure == "provenance" and role == "worker":
            provenance = "0" * 64
        platform = (
            "arm64"
            if self.failure == "image_platform" and role == "worker"
            else "amd64"
        )
        object_id = (
            DRIFTED_IMAGE_ID
            if self.failure == "image_object_id" and role == "worker"
            else None
        )
        return FakeImage(
            image_id,
            provenance,
            platform=platform,
            object_id=object_id,
        )


class FakeVolume:
    def __init__(
        self,
        name: str,
        role: str,
        events: list[str],
        failure: str | None,
    ) -> None:
        self.name = name
        self.role = role
        self.events = events
        self.failure = failure
        self.removed = False

    def remove(self, *, force: bool = False) -> None:
        self.events.append(f"volume.remove:{self.role}")
        if force is not True:
            raise AssertionError("volume removal must be forced")
        if self.failure == "volume_remove" and self.role == "worker":
            raise RuntimeError("injected volume removal failure")
        self.removed = True


class FakeVolumes:
    def __init__(self, events: list[str], failure: str | None) -> None:
        self.events = events
        self.failure = failure
        self.created: list[FakeVolume] = []
        self.create_calls: list[tuple[str, Mapping[str, str]]] = []

    def create(self, *, name: str, labels: Mapping[str, str]) -> FakeVolume:
        if type(labels) is not dict:
            raise AssertionError("docker-py volume labels must be a dictionary")
        role = labels["io.repofixlab.role"]
        self.events.append(f"volume.create:{role}")
        self.create_calls.append((name, dict(labels)))
        if self.failure == "volume_create" and role == "worker":
            raise RuntimeError("injected volume create failure")
        volume = FakeVolume(name, role, self.events, self.failure)
        self.created.append(volume)
        return volume

    def list(self, *, filters: Mapping[str, object]) -> list[FakeVolume]:
        labels = filters["label"]
        assert isinstance(labels, list)
        role = str(next(label for label in labels if "role=" in str(label))).rsplit(
            "=", 1
        )[1]
        self.events.append(f"volume.list:{role}")
        if self.failure == "residual_volume" and role == "worker":
            return [FakeVolume("residual-volume", role, self.events, None)]
        if self.failure == "volume_list" and role == "worker":
            raise RuntimeError("injected volume list failure")
        return []


class FakeContainer:
    def __init__(
        self,
        container_id: str,
        role: str,
        attrs: Mapping[str, object],
        stdout: bytes,
        events: list[str],
        failure: str | None,
    ) -> None:
        self.id = container_id
        self.role = role
        self.attrs = dict(attrs)
        self.stdout = stdout
        self.events = events
        self.failure = failure
        self.removed = False

    def wait(self, *, timeout: int | None = None) -> Mapping[str, object]:
        self.events.append(f"container.wait:{self.role}")
        if timeout != 60:
            raise AssertionError("timeout must come from the candidate")
        if self.failure == "wait" and self.role == "worker":
            raise RuntimeError("injected wait failure")
        if self.failure == "timeout" and self.role == "worker":
            raise TimeoutError("injected timeout")
        return {
            "StatusCode": 42
            if self.failure == "exit_nonzero" and self.role == "worker"
            else 0
        }

    def logs(self, *, stderr: bool = True, stdout: bool = True) -> bytes:
        stream = "stdout" if stdout else "stderr"
        self.events.append(f"container.logs.{stream}:{self.role}")
        if self.failure == "logs" and self.role == "worker":
            raise RuntimeError("injected logs failure")
        return self.stdout if stdout else b""

    def remove(self, *, force: bool = False) -> None:
        self.events.append(f"container.remove:{self.role}")
        if force is not True:
            raise AssertionError("container removal must be forced")
        if self.failure == "container_remove" and self.role == "worker":
            raise RuntimeError("injected container removal failure")
        self.removed = True


class FakeContainers:
    def __init__(self, events: list[str], failure: str | None) -> None:
        self.events = events
        self.failure = failure
        self.run_calls: list[tuple[str, list[str], dict[str, object]]] = []
        self.created: dict[str, FakeContainer] = {}

    def _probe_stdout(self, role: str, environment: Mapping[str, str]) -> bytes:
        value: dict[str, object] = {
            "schema_version": "v1",
            "probe_type": "task_role_factory_active_probe",
            "probe_sha256": environment["REPOFIX_EXPECTED_PROBE_SHA256"],
            "nonce": environment["REPOFIX_ACTIVE_PROBE_NONCE"],
            "observed_uid": 65532,
            "observed_gid": 65532,
            "observed_base_commit": environment["REPOFIX_EXPECTED_BASE_COMMIT"],
            "writable_path_roundtrip": True,
            "docker_socket_paths_present": [],
            "sensitive_environment_names_present": [],
            "errors": [],
        }
        if role == "worker":
            if self.failure == "active_nonce":
                value["nonce"] = "0" * 32
            elif self.failure == "active_uid":
                value["observed_uid"] = 0
            elif self.failure == "active_gid":
                value["observed_gid"] = 0
            elif self.failure == "active_head":
                value["observed_base_commit"] = "0" * 40
            elif self.failure == "active_writable":
                value["writable_path_roundtrip"] = False
            elif self.failure == "active_socket":
                value["docker_socket_paths_present"] = ["/var/run/docker.sock"]
            elif self.failure == "active_env":
                value["sensitive_environment_names_present"] = ["OPENAI_API_KEY"]
            elif self.failure == "active_extra":
                value["extra"] = True
            elif self.failure == "active_json":
                return b"not-json\n"
        return (
            json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()

    def run(
        self,
        image: str,
        command: list[str],
        **kwargs: object,
    ) -> FakeContainer:
        environment = kwargs["environment"]
        assert isinstance(environment, Mapping)
        role_value = environment["REPOFIX_ROLE"]
        assert isinstance(role_value, str)
        role = role_value
        self.events.append(f"container.run:{role}")
        self.run_calls.append((image, command, dict(kwargs)))
        if self.failure == "run" and role == "worker":
            raise RuntimeError("injected run failure")
        volumes = kwargs["volumes"]
        tmpfs = kwargs["tmpfs"]
        labels = kwargs["labels"]
        assert isinstance(volumes, Mapping)
        assert isinstance(tmpfs, Mapping)
        assert isinstance(labels, Mapping)
        mounts: list[dict[str, object]] = []
        binds: list[str] = []
        for volume_name, mount_value in volumes.items():
            assert isinstance(volume_name, str)
            assert isinstance(mount_value, Mapping)
            destination = mount_value["bind"]
            assert isinstance(destination, str)
            mounts.append(
                {
                    "Type": "volume",
                    "Name": volume_name,
                    "Destination": destination,
                    "RW": True,
                }
            )
            binds.append(f"{volume_name}:{destination}:rw")
        if self.failure == "tmpfs_in_mounts":
            for destination in tmpfs:
                mounts.append(
                    {
                        "Type": "tmpfs",
                        "Destination": destination,
                        "RW": True,
                    }
                )
        inspected_labels = dict(labels)
        if self.failure == "label_drift" and role == "worker":
            inspected_labels["io.repofixlab.role"] = "evaluator"
        environment_list = ["PATH=/usr/bin"] + [
            f"{name}={value}" for name, value in environment.items()
        ]
        attrs: dict[str, object] = {
            "Image": image,
            "Config": {
                "Image": image,
                "User": kwargs["user"],
                "Env": environment_list,
                "Labels": inspected_labels,
                "ExposedPorts": None,
                "Tty": kwargs["tty"],
                "OpenStdin": kwargs["stdin_open"],
            },
            "HostConfig": {
                "NetworkMode": kwargs["network_mode"],
                "ReadonlyRootfs": kwargs["read_only"],
                "Privileged": kwargs["privileged"],
                "AutoRemove": kwargs["auto_remove"],
                "NanoCpus": kwargs["nano_cpus"],
                "Memory": kwargs["mem_limit"],
                "MemorySwap": kwargs["memswap_limit"],
                "PidsLimit": kwargs["pids_limit"],
                "CapDrop": kwargs["cap_drop"],
                "CapAdd": kwargs["cap_add"],
                "SecurityOpt": kwargs["security_opt"],
                "Devices": kwargs["devices"],
                "PortBindings": {},
                "Binds": binds,
                "Tmpfs": dict(tmpfs),
            },
            "NetworkSettings": {"Ports": {}, "Networks": {}},
            "Mounts": mounts,
        }
        if role == "worker":
            if self.failure == "inspect_image":
                attrs["Image"] = DRIFTED_IMAGE_ID
            elif self.failure == "inspect_network":
                host = attrs["HostConfig"]
                assert isinstance(host, dict)
                host["NetworkMode"] = "bridge"
            elif self.failure == "inspect_user":
                config = attrs["Config"]
                assert isinstance(config, dict)
                config["User"] = "0:0"
            elif self.failure == "inspect_socket":
                mounts.append(
                    {
                        "Type": "bind",
                        "Source": "/var/run/docker.sock",
                        "Destination": "/var/run/docker.sock",
                        "RW": True,
                    }
                )
            elif self.failure == "inspect_env":
                environment_list.append("OPENAI_API_KEY=secret")
            elif self.failure == "inspect_resource":
                host = attrs["HostConfig"]
                assert isinstance(host, dict)
                host["NanoCpus"] = 1_000_000_000
        container_id = ("c" if role == "worker" else "d") * 64
        container = FakeContainer(
            container_id,
            role,
            attrs,
            self._probe_stdout(role, environment),
            self.events,
            self.failure,
        )
        self.created[container_id] = container
        return container

    def get(self, container_id: str) -> FakeContainer:
        container = self.created[container_id]
        self.events.append(f"container.get:{container.role}")
        if self.failure == "inspect" and container.role == "worker":
            raise RuntimeError("injected inspect failure")
        return container

    def list(
        self,
        *,
        all: bool = False,
        filters: Mapping[str, object] | None = None,
    ) -> list[FakeContainer]:
        if all is not True or filters is None:
            raise AssertionError("residual audit must include stopped containers")
        labels = filters["label"]
        assert isinstance(labels, list)
        role = str(next(label for label in labels if "role=" in str(label))).rsplit(
            "=", 1
        )[1]
        self.events.append(f"container.list:{role}")
        if self.failure == "residual_container" and role == "worker":
            return [self.created["c" * 64]]
        if self.failure == "container_list" and role == "worker":
            raise RuntimeError("injected container list failure")
        return []


class FakeDockerClient:
    def __init__(self, failure: str | None = None) -> None:
        self.events: list[str] = []
        self.images = FakeImages(self.events, failure)
        self.volumes = FakeVolumes(self.events, failure)
        self.containers = FakeContainers(self.events, failure)


class FakeControllerInspectClient:
    def __init__(self, failure: str | None = None) -> None:
        container_id = "f" * 64 if failure == "hostname_prefix" else CONTROLLER_ID
        mounts: list[dict[str, object]] = [
            {
                "Type": "bind",
                "Source": (
                    "/run/host-services/docker.proxy.sock"
                    if failure == "desktop_socket"
                    else (
                        "/run/docker.sock"
                        if failure == "wrong_socket_source"
                        else "/var/run/docker.sock"
                    )
                ),
                "Destination": (
                    "/run/docker.sock"
                    if failure == "wrong_socket_destination"
                    else "/var/run/docker.sock"
                ),
                "RW": failure != "socket_read_only",
            },
            {
                "Type": "volume",
                "Name": "repofixlab_controller-work-v2",
                "Destination": "/var/lib/repofix/controller",
                "RW": True,
            },
            {
                "Type": "volume",
                "Name": "repofixlab_controller-candidates-v1",
                "Destination": "/etc/repofixlab/candidates",
                "RW": failure == "candidate_writable",
            },
        ]
        if failure == "source_bind":
            mounts.append(
                {
                    "Type": "bind",
                    "Source": "/workspace/source",
                    "Destination": "/source",
                    "RW": True,
                }
            )
        attachments: dict[str, object] = {
            "repofix-control": {"NetworkID": CONTROL_NETWORK_ID}
        }
        if failure == "extra_network":
            attachments["provider-egress"] = {"NetworkID": "6" * 64}
        port_bindings: dict[str, object] = {}
        network_ports: dict[str, object] = {}
        if failure == "published_port":
            binding = [{"HostIp": "0.0.0.0", "HostPort": "8000"}]
            port_bindings["8000/tcp"] = binding
            network_ports["8000/tcp"] = binding
        self.container_get_calls: list[str] = []
        container = FakeContainer(
            container_id,
            "controller",
            {
                "Id": container_id,
                "Image": CONTROLLER_IMAGE_ID,
                "Config": {
                    "Labels": {
                        "com.docker.compose.project": "repofixlab",
                        "com.docker.compose.service": "controller",
                        "com.docker.compose.config-hash": CONTROLLER_CONFIG_SHA256,
                    }
                },
                "HostConfig": {
                    "ReadonlyRootfs": True,
                    "CapDrop": ["ALL"],
                    "SecurityOpt": ["no-new-privileges:true"],
                    "PortBindings": port_bindings,
                    "Tmpfs": {"/tmp": ""},
                },
                "NetworkSettings": {
                    "Ports": network_ports,
                    "Networks": attachments,
                },
                "Mounts": mounts,
            },
            b"",
            [],
            None,
        )

        class Containers:
            def get(inner_self, reference: str) -> FakeContainer:
                self.container_get_calls.append(reference)
                return container

        compose_hash = (
            "8" * 64 if failure == "compose_config" else CONTROLLER_CONFIG_SHA256
        )
        image = FakeImage(CONTROLLER_IMAGE_ID, WORKER_PROVENANCE)
        image_config = image.attrs["Config"]
        assert isinstance(image_config, dict)
        image_labels = image_config["Labels"]
        assert isinstance(image_labels, dict)
        image_labels["io.repofixlab.compose-config-sha256"] = compose_hash

        class Images:
            def get(inner_self, image_id: str) -> FakeImage:
                if image_id != CONTROLLER_IMAGE_ID:
                    raise AssertionError("Controller image lookup must use exact image ID")
                return image

        class Network:
            attrs = {
                "Id": CONTROL_NETWORK_ID,
                "Internal": True,
                "Labels": {
                    "com.docker.compose.project": "repofixlab",
                    "com.docker.compose.network": "repofix-control",
                },
            }

        class Networks:
            def get(inner_self, network_id: str) -> Network:
                if network_id != CONTROL_NETWORK_ID:
                    raise AssertionError("unexpected network lookup")
                return Network()

        self.containers = Containers()
        self.images = Images()
        self.networks = Networks()


def _factory(client: FakeDockerClient):
    nonces = iter((WORKER_NONCE, EVALUATOR_NONCE))
    timestamps = iter(("2026-07-18T00:00:00Z", "2026-07-18T00:00:01Z"))
    monotonic_values = iter((100, 120, 200, 230))
    resolver = _resolver()
    return (
        RoleContainerFactory(
            client,
            resolver,
            controller_execution=_controller_execution(),
            nonce_factory=lambda: next(nonces),
            clock=lambda: next(timestamps),
            monotonic_ms=lambda: next(monotonic_values),
        ),
        _request(resolver),
    )


class ContainerFactoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        schema_path = (
            PACKAGE_ROOT
            / "schemas"
            / "v1"
            / "task-role-factory-probe-report.schema.json"
        )
        cls.report_schema = json.loads(schema_path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(cls.report_schema)
        cls.report_validator = Draft202012Validator(cls.report_schema)

    def test_generated_report_schema_is_valid_draft_2020_12(self) -> None:
        self.assertEqual(
            self.report_schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema",
        )
        Draft202012Validator.check_schema(self.report_schema)

    def test_controller_execution_uses_hostname_lookup_then_exact_full_inspect(self) -> None:
        client = FakeControllerInspectClient()

        evidence = inspect_controller_execution(
            client,
            container_hostname=CONTROLLER_HOSTNAME,
            compose_project="repofixlab",
        )

        self.assertEqual(client.container_get_calls, [CONTROLLER_HOSTNAME])
        self.assertEqual(evidence.container_id, CONTROLLER_ID)
        self.assertEqual(evidence.image_id, CONTROLLER_IMAGE_ID)
        self.assertEqual(evidence.compose_config_sha256, CONTROLLER_CONFIG_SHA256)
        self.assertEqual(len(evidence.networks), 1)
        self.assertTrue(evidence.networks[0].internal)
        self.assertEqual(len(evidence.mounts), 4)

    def test_controller_execution_rejects_identity_and_policy_drift(self) -> None:
        for failure in (
            "hostname_prefix",
            "source_bind",
            "extra_network",
            "published_port",
            "compose_config",
            "candidate_writable",
            "wrong_socket_source",
            "wrong_socket_destination",
            "socket_read_only",
        ):
            with self.subTest(failure=failure):
                with self.assertRaises(ContainerFactoryError):
                    inspect_controller_execution(
                        FakeControllerInspectClient(failure),
                        container_hostname=CONTROLLER_HOSTNAME,
                        compose_project="repofixlab",
                    )

    def test_controller_execution_accepts_exact_docker_desktop_socket_source(
        self,
    ) -> None:
        evidence = inspect_controller_execution(
            FakeControllerInspectClient("desktop_socket"),
            container_hostname=CONTROLLER_HOSTNAME,
            compose_project="repofixlab",
        )

        socket_mounts = [
            mount
            for mount in evidence.mounts
            if mount.destination == "/var/run/docker.sock"
        ]
        self.assertEqual(len(socket_mounts), 1)
        self.assertEqual(
            socket_mounts[0].source,
            "/run/host-services/docker.proxy.sock",
        )

    def test_success_matches_ts_v1_report_and_uses_independent_testbed_volumes(self) -> None:
        client = FakeDockerClient()
        factory, request = _factory(client)

        report = factory.execute_probe(request)
        payload = report.to_dict()

        self.report_validator.validate(payload)
        self.assertEqual(payload["report_type"], "task_role_factory_probe")
        self.assertEqual(payload["probe_profile"], TASK_ROLE_FACTORY_PROBE_PROFILE)
        self.assertEqual(payload["instance_id"], AXIOS_SMOKE_INSTANCE_ID)
        self.assertEqual(payload["base_commit"], AXIOS_SMOKE_BASE_COMMIT)
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(payload["execution_order"], ["worker", "evaluator"])
        roles = payload["roles"]
        assert isinstance(roles, dict)
        worker = roles["worker"]
        evaluator = roles["evaluator"]
        assert isinstance(worker, dict)
        assert isinstance(evaluator, dict)
        self.assertEqual(worker["status"], "pass")
        self.assertIsNone(worker["failure_phase"])
        self.assertEqual(worker["actual_provenance_sha256"], WORKER_PROVENANCE)
        active = worker["active_probe"]
        inspect_evidence = worker["inspect"]
        assert isinstance(active, dict)
        assert isinstance(inspect_evidence, dict)
        self.assertEqual(active["probe_sha256"], PROBE_SHA256)
        self.assertEqual(active["nonce_sha256"], hashlib.sha256(WORKER_NONCE.encode()).hexdigest())
        self.assertEqual(active["observed_uid"], 65532)
        self.assertEqual(active["observed_gid"], 65532)
        self.assertEqual(active["observed_base_commit"], AXIOS_SMOKE_BASE_COMMIT)
        self.assertEqual(active["duration_ms"], 20)
        self.assertTrue(active["writable_path_roundtrip"])
        mounts = inspect_evidence["mounts"]
        assert isinstance(mounts, list)
        self.assertEqual(
            [(mount["type"], mount["destination"]) for mount in mounts],
            [("tmpfs", "/tmp"), ("volume", "/testbed")],
        )
        worker_cleanup = worker["cleanup"]
        evaluator_cleanup = evaluator["cleanup"]
        assert isinstance(worker_cleanup, dict)
        assert isinstance(evaluator_cleanup, dict)
        worker_volume = worker_cleanup["created_volume_names"]
        evaluator_volume = evaluator_cleanup["created_volume_names"]
        self.assertNotEqual(worker_volume, evaluator_volume)
        self.assertEqual(worker_volume, worker_cleanup["removed_volume_names"])
        self.assertEqual(evaluator_volume, evaluator_cleanup["removed_volume_names"])
        self.assertLess(
            client.events.index("volume.remove:worker"),
            client.events.index("container.run:evaluator"),
        )
        for role_evidence in (worker, evaluator):
            unsigned = dict(role_evidence)
            evidence_hash = unsigned.pop("evidence_sha256")
            self.assertEqual(evidence_hash, _canonical_hash(unsigned))
        unsigned_report = dict(payload)
        report_hash = unsigned_report.pop("report_sha256")
        self.assertEqual(report_hash, _canonical_hash(unsigned_report))

    def test_run_kwargs_are_exact_and_no_arbitrary_docker_entry_exists(self) -> None:
        client = FakeDockerClient()
        factory, request = _factory(client)

        report = factory.execute_probe(request)

        self.assertEqual(report.status, "pass")
        self.assertEqual(len(client.containers.run_calls), 2)
        image, command, options = client.containers.run_calls[0]
        self.assertEqual(image, WORKER_IMAGE_ID)
        self.assertEqual(command, ["/opt/repofixlab/bin/active-probe"])
        self.assertEqual(options["network_mode"], "none")
        self.assertTrue(options["read_only"])
        self.assertEqual(options["cap_drop"], ["ALL"])
        self.assertEqual(options["cap_add"], [])
        self.assertEqual(options["security_opt"], ["no-new-privileges:true"])
        self.assertFalse(options["privileged"])
        self.assertEqual(options["devices"], [])
        self.assertEqual(options["ports"], {})
        self.assertFalse(options["tty"])
        self.assertFalse(options["stdin_open"])
        self.assertFalse(options["auto_remove"])
        self.assertTrue(options["detach"])
        self.assertEqual(options["nano_cpus"], 4_000_000_000)
        volumes = options["volumes"]
        assert isinstance(volumes, dict)
        self.assertEqual(next(iter(volumes.values())), {"bind": "/testbed", "mode": "rw"})
        self.assertFalse(hasattr(client.images, "pull"))
        self.assertFalse(hasattr(client.images, "build"))
        self.assertFalse(hasattr(client.containers, "create"))
        self.assertEqual(set(inspect.signature(factory.execute_probe).parameters), {"request"})

    def test_tmpfs_is_synthesized_when_real_inspect_omits_it(self) -> None:
        for failure in (None, "tmpfs_in_mounts"):
            with self.subTest(tmpfs_returned_in_mounts=failure is not None):
                client = FakeDockerClient(failure)
                factory, request = _factory(client)

                report = factory.execute_probe(request)

                self.assertEqual(report.status, "pass")
                mounts = report.worker.inspect
                assert mounts is not None
                tmpfs_mounts = [mount for mount in mounts.mounts if mount.type == "tmpfs"]
                self.assertEqual(len(tmpfs_mounts), 1)
                self.assertEqual(tmpfs_mounts[0].source, None)
                self.assertEqual(tmpfs_mounts[0].destination, "/tmp")

    def test_image_provenance_comes_from_locked_image_label(self) -> None:
        for failure in ("provenance", "image_platform", "image_object_id"):
            with self.subTest(failure=failure):
                client = FakeDockerClient(failure)
                factory, request = _factory(client)

                report = factory.execute_probe(request)

                self.assertEqual(report.worker.status, "fail")
                self.assertEqual(report.worker.failure_phase, "image_inspect")
                self.assertEqual(report.evaluator.status, "fail")
                self.assertEqual(report.evaluator.failure_phase, "candidate_validation")
                self.assertEqual(len(client.containers.run_calls), 0)

    def test_active_and_runtime_drift_fail_closed_with_v1_evidence(self) -> None:
        failures = (
            "active_json",
            "active_extra",
            "active_nonce",
            "active_uid",
            "active_gid",
            "active_head",
            "active_writable",
            "active_socket",
            "active_env",
            "exit_nonzero",
            "timeout",
            "inspect_image",
            "inspect_network",
            "inspect_user",
            "inspect_socket",
            "inspect_env",
            "inspect_resource",
        )
        for failure in failures:
            with self.subTest(failure=failure):
                client = FakeDockerClient(failure)
                factory, request = _factory(client)

                report = factory.execute_probe(request)
                payload = report.to_dict()

                self.report_validator.validate(payload)
                self.assertEqual(report.status, "fail")
                self.assertEqual(report.worker.status, "fail")
                self.assertIsNotNone(report.worker.failure_phase)
                self.assertEqual(report.evaluator.status, "fail")
                self.assertEqual(report.evaluator.failure_phase, "candidate_validation")
                self.assertEqual(len(client.containers.run_calls), 1)

    def test_every_failure_cleans_and_cleanup_or_residual_failure_is_evidence(self) -> None:
        failures = (
            "image_get",
            "volume_create",
            "run",
            "wait",
            "logs",
            "inspect",
            "container_remove",
            "volume_remove",
            "residual_container",
            "residual_volume",
            "container_list",
            "volume_list",
        )
        for failure in failures:
            with self.subTest(failure=failure):
                client = FakeDockerClient(failure)
                factory, request = _factory(client)

                report = factory.execute_probe(request)
                payload = report.to_dict()

                self.report_validator.validate(payload)
                self.assertEqual(report.worker.status, "fail")
                self.assertEqual(report.evaluator.status, "fail")
                self.assertEqual(len(client.containers.run_calls), 0 if failure in {"image_get", "volume_create"} else 1)
                cleanup = report.worker.cleanup
                if failure in {
                    "container_remove",
                    "volume_remove",
                    "residual_container",
                    "residual_volume",
                    "container_list",
                    "volume_list",
                }:
                    self.assertTrue(
                        cleanup.errors
                        or cleanup.residual_container_ids
                        or cleanup.residual_volume_names
                    )

    def test_resolver_binds_candidate_request_and_rejects_policy_escape(self) -> None:
        resolver = _resolver()
        valid_request_sha256 = task_role_factory_probe_request_sha256(
            operation_id="operation-1",
            candidate_id="candidate-1",
            candidate_sha256=CANDIDATE_SHA256,
        )
        with self.assertRaises(ContainerFactoryError):
            resolver.resolve_request(
                operation_id="operation-1",
                candidate_id="candidate-1",
                candidate_sha256="0" * 64,
                request_sha256=valid_request_sha256,
            )
        with self.assertRaises(ContainerFactoryError):
            resolver.resolve_request(
                operation_id="operation-1",
                candidate_id="candidate-1",
                candidate_sha256=CANDIDATE_SHA256,
                request_sha256="0" * 64,
            )
        invalid_workers = (
            replace(_policy("worker"), user="0:0"),
            replace(_policy("worker"), nano_cpus=4_000_000_001),
            replace(_policy("worker"), memory_bytes=16 * 1024 * 1024 - 1),
            replace(
                _policy("worker"),
                memory_swap_bytes=_policy("worker").memory_bytes + 1,
            ),
            replace(_policy("worker"), pids_limit=513),
            replace(_policy("worker"), timeout_seconds=3601),
            replace(
                _policy("worker"),
                managed_volumes=(ManagedVolumePolicy("host", "/host"),),
            ),
            replace(
                _policy("worker"),
                allowed_image_environment_names=("OPENAI_API_KEY",),
            ),
        )
        for worker in invalid_workers:
            with self.assertRaises(ContainerFactoryError):
                TrustedCandidateResolver(
                    {
                        "candidate-1": CandidateLaunchDefinition(
                            candidate_sha256=CANDIDATE_SHA256,
                            instance_id=AXIOS_SMOKE_INSTANCE_ID,
                            base_commit=AXIOS_SMOKE_BASE_COMMIT,
                            probe_sha256=PROBE_SHA256,
                            worker=worker,
                            evaluator=_policy("evaluator"),
                        )
                    }
                )

    def test_resolver_accepts_the_m0_four_cpu_hard_limit(self) -> None:
        resolver = _resolver()

        request = _request(resolver)

        self.assertEqual(request.worker.nano_cpus, 4_000_000_000)
        self.assertEqual(request.evaluator.nano_cpus, 4_000_000_000)

    def test_resolver_binds_a_repository_qualified_non_axios_task(self) -> None:
        instance_id = "immutable-js__immutable-js-2005"
        base_commit = "1" * 40
        resolver = TrustedCandidateResolver(
            {
                "candidate-immutable": CandidateLaunchDefinition(
                    candidate_sha256=CANDIDATE_SHA256,
                    instance_id=instance_id,
                    base_commit=base_commit,
                    probe_sha256=PROBE_SHA256,
                    worker=_policy("worker"),
                    evaluator=_policy("evaluator"),
                )
            }
        )
        request_sha256 = task_role_factory_probe_request_sha256(
            operation_id="operation-immutable",
            candidate_id="candidate-immutable",
            candidate_sha256=CANDIDATE_SHA256,
        )
        request = resolver.resolve_request(
            operation_id="operation-immutable",
            candidate_id="candidate-immutable",
            candidate_sha256=CANDIDATE_SHA256,
            request_sha256=request_sha256,
        )

        self.assertEqual(request.instance_id, instance_id)
        self.assertEqual(request.base_commit, base_commit)

    def test_labels_are_correlation_only_not_pass_evidence(self) -> None:
        client = FakeDockerClient("label_drift")
        factory, request = _factory(client)

        report = factory.execute_probe(request)

        self.assertEqual(report.status, "pass")


if __name__ == "__main__":
    unittest.main()
