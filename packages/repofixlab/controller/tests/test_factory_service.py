from __future__ import annotations

from collections.abc import Mapping
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import sys
from tempfile import TemporaryDirectory
from threading import Event, Thread
import time
import unittest
import urllib.error
import urllib.request

from jsonschema import Draft202012Validator
import uvicorn


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIRECTORY = PACKAGE_ROOT / "schemas" / "v1"
os.environ["REPOFIXLAB_SCHEMA_PATH"] = str(
    SCHEMA_DIRECTORY / "controller-bootstrap-health.schema.json"
)
sys.path.insert(0, str(PACKAGE_ROOT / "controller" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from repofixlab_controller.app import create_app  # noqa: E402
from repofixlab_controller.container_factory import (  # noqa: E402
    AXIOS_SMOKE_BASE_COMMIT,
    AXIOS_SMOKE_INSTANCE_ID,
    RoleContainerFactory,
    task_role_factory_probe_request_sha256,
)
from repofixlab_controller.factory_service import (  # noqa: E402
    FACTORY_IMAGE_ENVIRONMENT_ALLOWLIST,
    FACTORY_ROLE_COMMAND,
    FACTORY_TMPFS_OPTIONS,
    CandidateCatalogError,
    FactoryHttpRequest,
    FactoryOperationJournal,
    FactoryOperationService,
    FactoryRecoveryError,
    FactoryServiceUnavailable,
    TrustedCandidateCatalog,
)
from test_container_factory import (  # noqa: E402
    CANDIDATE_SHA256,
    EVALUATOR_IMAGE_ID,
    EVALUATOR_PROVENANCE,
    FakeDockerClient,
    PROBE_SHA256,
    SANITIZER_SHA256,
    WORKER_IMAGE_ID,
    WORKER_PROVENANCE,
    _controller_execution,
)


def _canonical_hash(value: object) -> str:
    content = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def _profile(
    role: str,
    kind: str,
    body: Mapping[str, object],
) -> dict[str, object]:
    profile_id = (
        f"task-environment-profile-v1-axios-5892-{role}-{kind}-"
        f"{_canonical_hash(body)}"
    )
    unsigned = {"profile_id": profile_id, **body}
    return {**unsigned, "profile_sha256": _canonical_hash(unsigned)}


def _security_profile(role: str) -> dict[str, object]:
    body = {
        "network_mode": "none",
        "read_only_root_filesystem": True,
        "cap_drop": ["ALL"],
        "cap_add": [],
        "no_new_privileges": True,
        "privileged": False,
        "devices": [],
        "host_bind_mounts_allowed": False,
        "docker_socket_allowed": False,
        "published_ports_allowed": False,
        "sensitive_environment_allowed": False,
        "tty": False,
        "stdin_open": False,
        "auto_remove": False,
    }
    return _profile(role, "security", body)


def _resource_profile(role: str) -> dict[str, object]:
    body = {
        "nano_cpus": 500_000_000,
        "memory_bytes": 256 * 1024 * 1024,
        "memory_swap_bytes": 256 * 1024 * 1024,
        "pids_limit": 128,
        "timeout_seconds": 60,
    }
    return _profile(role, "resource", body)


def _filesystem_profile(role: str) -> dict[str, object]:
    mounts = [
        {"type": "volume", "destination": "/testbed", "read_write": True},
        {"type": "tmpfs", "destination": "/tmp", "read_write": True},
    ]
    mounts.sort(key=lambda mount: (str(mount["destination"]), str(mount["type"])))
    return _profile(role, "filesystem", {"writable_mounts": mounts})


def _candidate(variant: int = 1) -> dict[str, object]:
    identity: dict[str, object] = {
        "schema_version": "v1",
        "candidate_type": "task_environment_candidate",
        "instance_id": AXIOS_SMOKE_INSTANCE_ID,
        "base_commit": AXIOS_SMOKE_BASE_COMMIT,
        "dataset_lock": {
            "lock_id": f"dataset-lock-v{variant}",
            "lock_sha256": str(variant) * 64,
        },
        "official_image_source_lock": {
            "lock_id": "official-images-v1",
            "lock_sha256": "b" * 64,
        },
        "roles": {
            "worker": {
                "role": "worker",
                "image": {
                    "local_image_id": WORKER_IMAGE_ID,
                    "platform": "linux/amd64",
                    "provenance_sha256": WORKER_PROVENANCE,
                },
                "runtime_user": {"uid": 65532, "gid": 65532},
                "security_profile": _security_profile("worker"),
                "resource_profile": _resource_profile("worker"),
                "filesystem_profile": _filesystem_profile("worker"),
            },
            "evaluator": {
                "role": "evaluator",
                "image": {
                    "local_image_id": EVALUATOR_IMAGE_ID,
                    "platform": "linux/amd64",
                    "provenance_sha256": EVALUATOR_PROVENANCE,
                },
                "runtime_user": {"uid": 65532, "gid": 65532},
                "security_profile": _security_profile("evaluator"),
                "resource_profile": _resource_profile("evaluator"),
                "filesystem_profile": _filesystem_profile("evaluator"),
            },
        },
        "probe_sha256": PROBE_SHA256,
        "sanitizer_sha256": SANITIZER_SHA256,
        "adapter_sha256": "3" * 64,
    }
    candidate_id = (
        "task-environment-candidate-v1-axios-5892-"
        f"{_canonical_hash(identity)}"
    )
    unsigned = {
        **identity,
        "candidate_id": candidate_id,
        "created_at": "2026-07-18T12:00:00.000Z",
    }
    return {**unsigned, "candidate_sha256": _canonical_hash(unsigned)}


CANDIDATE_ID = str(_candidate()["candidate_id"])
SECOND_CANDIDATE_ID = str(_candidate(2)["candidate_id"])


def _resign(candidate: dict[str, object]) -> None:
    candidate.pop("candidate_sha256", None)
    candidate["candidate_sha256"] = _canonical_hash(candidate)


def _reidentify_and_resign(candidate: dict[str, object]) -> None:
    identity = dict(candidate)
    identity.pop("candidate_id", None)
    identity.pop("candidate_sha256", None)
    identity.pop("created_at", None)
    candidate["candidate_id"] = (
        "task-environment-candidate-v1-axios-5892-"
        f"{_canonical_hash(identity)}"
    )
    _resign(candidate)


def _write_candidates(directory: Path, *candidates: Mapping[str, object]) -> None:
    directory.mkdir()
    for index, candidate in enumerate(candidates):
        (directory / f"candidate-{index}.json").write_text(
            json.dumps(candidate, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )


def _catalog(directory: Path) -> TrustedCandidateCatalog:
    return TrustedCandidateCatalog.load(
        directory,
        SCHEMA_DIRECTORY / "task-environment-candidate.schema.json",
        read_only_check=lambda _path: True,
    )


def _service(
    client: FakeDockerClient,
    candidate_directory: Path,
    operation_root: Path,
) -> FactoryOperationService:
    return FactoryOperationService(
        client,
        _catalog(candidate_directory),
        operation_root,
        SCHEMA_DIRECTORY / "task-role-factory-probe-report.schema.json",
        controller_execution=_controller_execution(
            "/run/host-services/docker.proxy.sock"
        ),
    )


class _LiveServer:
    def __init__(self, service: FactoryOperationService) -> None:
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(128)
        self.port = int(self._socket.getsockname()[1])
        config = uvicorn.Config(
            create_app(factory_service=service, load_factory_from_environment=False),
            log_level="critical",
            lifespan="on",
        )
        self._server = uvicorn.Server(config)
        self._thread = Thread(
            target=self._server.run,
            kwargs={"sockets": [self._socket]},
            daemon=True,
        )

    def __enter__(self) -> _LiveServer:
        self._thread.start()
        deadline = time.monotonic() + 5
        while not self._server.started and self._thread.is_alive():
            if time.monotonic() > deadline:
                raise RuntimeError("test HTTP server did not start")
            time.sleep(0.01)
        return self

    def __exit__(self, *_args: object) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=5)
        self._socket.close()

    def post(self, value: Mapping[str, object]) -> tuple[int, Mapping[str, str], object]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/v1/factory/task-role-probes",
            data=json.dumps(value).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                body = json.loads(response.read().decode("utf-8"))
                return response.status, dict(response.headers.items()), body
        except urllib.error.HTTPError as error:
            body = json.loads(error.read().decode("utf-8"))
            return error.code, dict(error.headers.items()), body


class _BlockingContainer:
    def __init__(self, target: object, entered: Event, release: Event) -> None:
        self._target = target
        self._entered = entered
        self._release = release
        self.id = getattr(target, "id")
        self.attrs = getattr(target, "attrs")

    def wait(self, *, timeout: int | None = None) -> Mapping[str, object]:
        self._entered.set()
        if not self._release.wait(timeout=5):
            raise TimeoutError("blocking fake was not released")
        wait = getattr(self._target, "wait")
        return wait(timeout=timeout)

    def logs(self, *, stderr: bool = True, stdout: bool = True) -> bytes:
        logs = getattr(self._target, "logs")
        return logs(stderr=stderr, stdout=stdout)

    def remove(self, *, force: bool = False) -> None:
        remove = getattr(self._target, "remove")
        remove(force=force)


class _BlockingContainers:
    def __init__(self, target: object, entered: Event, release: Event) -> None:
        self._target = target
        self._entered = entered
        self._release = release

    @property
    def run_calls(self) -> object:
        return getattr(self._target, "run_calls")

    def run(self, image: str, command: list[str], **kwargs: object) -> object:
        run = getattr(self._target, "run")
        container = run(image, command, **kwargs)
        environment = kwargs["environment"]
        assert isinstance(environment, Mapping)
        if environment["REPOFIX_ROLE"] == "worker":
            return _BlockingContainer(container, self._entered, self._release)
        return container

    def get(self, container_id: str) -> object:
        get = getattr(self._target, "get")
        return get(container_id)

    def list(
        self,
        *,
        all: bool = False,
        filters: Mapping[str, object] | None = None,
    ) -> object:
        list_containers = getattr(self._target, "list")
        return list_containers(all=all, filters=filters)


class _EnvironmentDriftImages:
    def __init__(self, target: object, environment: str) -> None:
        self._target = target
        self._environment = environment

    def get(self, image_id: str) -> object:
        get = getattr(self._target, "get")
        image = get(image_id)
        config = image.attrs["Config"]
        assert isinstance(config, dict)
        environment = config["Env"]
        assert isinstance(environment, list)
        environment.append(self._environment)
        return image


class _ImageLabelDriftImages:
    def __init__(self, target: object, label: str, value: str) -> None:
        self._target = target
        self._label = label
        self._value = value

    def get(self, image_id: str) -> object:
        get = getattr(self._target, "get")
        image = get(image_id)
        config = image.attrs["Config"]
        assert isinstance(config, dict)
        labels = config["Labels"]
        assert isinstance(labels, dict)
        labels[self._label] = self._value
        return image


class FactoryServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        schema = json.loads(
            (
                SCHEMA_DIRECTORY / "task-role-factory-probe-report.schema.json"
            ).read_text(encoding="utf-8")
        )
        cls.report_validator = Draft202012Validator(schema)

    def _assert_candidate_catalog_rejected(
        self, candidate: Mapping[str, object]
    ) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            _write_candidates(candidates, candidate)
            with self.assertRaises(CandidateCatalogError):
                _catalog(candidates)

    def test_real_http_interface_is_strict_idempotent_and_conflict_safe(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            operations = root / "operations"
            _write_candidates(candidates, _candidate(), _candidate(2))
            client = FakeDockerClient()
            service = _service(client, candidates, operations)
            try:
                with _LiveServer(service) as server:
                    request = {
                        "operation_id": "operation-1",
                        "candidate_id": CANDIDATE_ID,
                        "instance_id": AXIOS_SMOKE_INSTANCE_ID,
                    }
                    status, headers, report = server.post(request)
                    replay_status, replay_headers, replay = server.post(request)
                    conflict_status, _conflict_headers, conflict = server.post(
                        {**request, "candidate_id": SECOND_CANDIDATE_ID}
                    )
                    invalid_status, _invalid_headers, invalid = server.post(
                        {
                            **request,
                            "operation_id": "operation-2",
                            "image": WORKER_IMAGE_ID,
                            "command": ["sh"],
                            "network_mode": "host",
                        }
                    )
                self.assertEqual(status, 200)
                self.assertEqual(replay_status, 200)
                self.assertEqual(headers["x-repofixlab-idempotent-replay"], "false")
                self.assertEqual(
                    replay_headers["x-repofixlab-idempotent-replay"], "true"
                )
                self.assertEqual(report, replay)
                assert isinstance(report, dict)
                self.report_validator.validate(report)
                self.assertEqual(len(client.containers.run_calls), 2)
                self.assertEqual(
                    client.containers.run_calls[0][1],
                    list(FACTORY_ROLE_COMMAND),
                )
                self.assertLess(
                    client.events.index("volume.remove:worker"),
                    client.events.index("container.run:evaluator"),
                )
                self.assertEqual(conflict_status, 409)
                self.assertEqual(
                    conflict,
                    {"detail": "operation_id conflicts with an existing request"},
                )
                self.assertEqual(invalid_status, 422)
                self.assertIn("detail", invalid)
                operation_directories = [
                    path for path in operations.iterdir() if path.name != ".owner.lock"
                ]
                self.assertEqual(len(operation_directories), 1)
                journal_lines = (
                    operation_directories[0] / "journal.jsonl"
                ).read_text(encoding="utf-8").splitlines()
                self.assertEqual(len(journal_lines), 2)
                self.assertTrue((operation_directories[0] / "report.json").is_file())
            finally:
                service.close()

    def test_recovery_cleanup_uncertainty_blocks_new_capacity(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            operations = root / "operations"
            _write_candidates(candidates, _candidate())
            catalog = _catalog(candidates)
            request = FactoryHttpRequest(
                "operation-1", CANDIDATE_ID, AXIOS_SMOKE_INSTANCE_ID
            )
            candidate = catalog.candidate(request.candidate_id)
            request_sha256 = task_role_factory_probe_request_sha256(
                operation_id=request.operation_id,
                candidate_id=request.candidate_id,
                candidate_sha256=candidate.candidate_sha256,
            )
            resolved = catalog.resolver.resolve_request(
                operation_id=request.operation_id,
                candidate_id=request.candidate_id,
                candidate_sha256=candidate.candidate_sha256,
                request_sha256=request_sha256,
            )
            journal = FactoryOperationJournal(operations)
            journal.begin(request, resolved, accepted_at="2026-07-18T12:00:00Z")
            journal.close()
            client = FakeDockerClient("container_list")
            service = FactoryOperationService(
                client,
                catalog,
                operations,
                SCHEMA_DIRECTORY / "task-role-factory-probe-report.schema.json",
                controller_execution=_controller_execution(),
            )
            try:
                replay = service.execute(request)
                self.assertEqual(replay.report["status"], "fail")
                with self.assertRaises(FactoryServiceUnavailable):
                    service.execute(
                        FactoryHttpRequest(
                            "operation-2",
                            CANDIDATE_ID,
                            AXIOS_SMOKE_INSTANCE_ID,
                        )
                    )
                self.assertEqual(len(client.containers.run_calls), 0)
            finally:
                service.close()

    def test_http_capacity_is_one_while_same_request_waits_for_same_terminal(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            _write_candidates(candidates, _candidate())
            client = FakeDockerClient()
            entered = Event()
            release = Event()
            client.containers = _BlockingContainers(client.containers, entered, release)
            service = _service(client, candidates, root / "operations")
            first_result: list[tuple[int, Mapping[str, str], object]] = []
            replay_result: list[tuple[int, Mapping[str, str], object]] = []
            try:
                with _LiveServer(service) as server:
                    request = {
                        "operation_id": "operation-1",
                        "candidate_id": CANDIDATE_ID,
                        "instance_id": AXIOS_SMOKE_INSTANCE_ID,
                    }
                    first = Thread(
                        target=lambda: first_result.append(server.post(request)),
                        daemon=True,
                    )
                    first.start()
                    self.assertTrue(entered.wait(timeout=5))
                    replay_thread = Thread(
                        target=lambda: replay_result.append(server.post(request)),
                        daemon=True,
                    )
                    replay_thread.start()
                    busy_status, _headers, busy = server.post(
                        {**request, "operation_id": "operation-2"}
                    )
                    self.assertEqual(busy_status, 429)
                    self.assertEqual(busy, {"detail": "factory capacity is busy"})
                    release.set()
                    first.join(timeout=5)
                    replay_thread.join(timeout=5)
                self.assertEqual(first_result[0][0], 200)
                self.assertEqual(replay_result[0][0], 200)
                self.assertEqual(first_result[0][2], replay_result[0][2])
                self.assertEqual(len(client.containers.run_calls), 2)
            finally:
                release.set()
                service.close()

    def test_persistent_owner_lease_rejects_a_second_controller(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            operations = root / "operations"
            _write_candidates(candidates, _candidate())
            first_client = FakeDockerClient()
            first = _service(first_client, candidates, operations)
            second_client = FakeDockerClient()
            try:
                with self.assertRaises(FactoryRecoveryError):
                    _service(second_client, candidates, operations)
                self.assertEqual(len(second_client.containers.run_calls), 0)
            finally:
                first.close()

    def test_interrupted_operation_recovers_fail_closed_without_container_run(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            operations = root / "operations"
            _write_candidates(candidates, _candidate())
            catalog = _catalog(candidates)
            request = FactoryHttpRequest(
                "operation-1", CANDIDATE_ID, AXIOS_SMOKE_INSTANCE_ID
            )
            candidate = catalog.candidate(request.candidate_id)
            request_sha256 = task_role_factory_probe_request_sha256(
                operation_id=request.operation_id,
                candidate_id=request.candidate_id,
                candidate_sha256=candidate.candidate_sha256,
            )
            resolved = catalog.resolver.resolve_request(
                operation_id=request.operation_id,
                candidate_id=request.candidate_id,
                candidate_sha256=candidate.candidate_sha256,
                request_sha256=request_sha256,
            )
            journal = FactoryOperationJournal(operations)
            journal.begin(
                request,
                resolved,
                accepted_at="2026-07-18T12:00:00Z",
            )
            journal.close()

            client = FakeDockerClient()
            service = FactoryOperationService(
                client,
                catalog,
                operations,
                SCHEMA_DIRECTORY / "task-role-factory-probe-report.schema.json",
                controller_execution=_controller_execution(),
            )
            try:
                result = service.execute(request)

                self.assertTrue(result.replayed)
                self.assertEqual(result.report["status"], "fail")
                self.report_validator.validate(result.report)
                self.assertEqual(len(client.containers.run_calls), 0)
                rendered = json.dumps(result.report)
                self.assertIn("factory:failed", rendered)
                self.assertNotIn("Traceback", rendered)
                operation_directory = next(
                    path for path in operations.iterdir() if path.name != ".owner.lock"
                )
                records = (operation_directory / "journal.jsonl").read_text(
                    encoding="utf-8"
                ).splitlines()
                self.assertEqual(len(records), 2)
                self.assertEqual(json.loads(records[1])["event"], "recovered_interrupted")
            finally:
                service.close()

    def test_corrupt_journal_blocks_recovery_and_never_runs_a_container(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            operations = root / "operations"
            _write_candidates(candidates, _candidate())
            catalog = _catalog(candidates)
            request = FactoryHttpRequest(
                "operation-1", CANDIDATE_ID, AXIOS_SMOKE_INSTANCE_ID
            )
            candidate = catalog.candidate(request.candidate_id)
            request_sha256 = task_role_factory_probe_request_sha256(
                operation_id=request.operation_id,
                candidate_id=request.candidate_id,
                candidate_sha256=candidate.candidate_sha256,
            )
            resolved = catalog.resolver.resolve_request(
                operation_id=request.operation_id,
                candidate_id=request.candidate_id,
                candidate_sha256=candidate.candidate_sha256,
                request_sha256=request_sha256,
            )
            journal = FactoryOperationJournal(operations)
            journal.begin(request, resolved, accepted_at="2026-07-18T12:00:00Z")
            journal.close()
            operation_directory = next(
                path for path in operations.iterdir() if path.name != ".owner.lock"
            )
            journal_path = operation_directory / "journal.jsonl"
            journal_path.write_text('{"corrupt":true}\n', encoding="utf-8")
            client = FakeDockerClient()

            with self.assertRaises(FactoryRecoveryError):
                FactoryOperationService(
                    client,
                    catalog,
                    operations,
                    SCHEMA_DIRECTORY / "task-role-factory-probe-report.schema.json",
                    controller_execution=_controller_execution(),
                )
            self.assertEqual(len(client.containers.run_calls), 0)

    def test_catalog_rejects_resigned_nested_profile_and_identity_drift(self) -> None:
        for role in ("worker", "evaluator"):
            for kind in ("security", "resource", "filesystem"):
                with self.subTest(role=role, kind=kind):
                    candidate = _candidate()
                    roles = candidate["roles"]
                    assert isinstance(roles, dict)
                    role_value = roles[role]
                    assert isinstance(role_value, dict)
                    profile = role_value[f"{kind}_profile"]
                    assert isinstance(profile, dict)
                    profile["profile_id"] = "resigned-nested-drift"
                    _reidentify_and_resign(candidate)
                    self._assert_candidate_catalog_rejected(candidate)

        candidate_id_drift = _candidate()
        candidate_id_drift["candidate_id"] = "resigned-candidate-id-drift"
        _resign(candidate_id_drift)
        self._assert_candidate_catalog_rejected(candidate_id_drift)

    def test_catalog_rejects_rebound_noncanonical_mount_order(self) -> None:
        candidate = _candidate()
        roles = candidate["roles"]
        assert isinstance(roles, dict)
        worker = roles["worker"]
        assert isinstance(worker, dict)
        filesystem = worker["filesystem_profile"]
        assert isinstance(filesystem, dict)
        mounts = filesystem["writable_mounts"]
        assert isinstance(mounts, list)
        mounts.reverse()
        body = {"writable_mounts": mounts}
        worker["filesystem_profile"] = _profile("worker", "filesystem", body)
        _reidentify_and_resign(candidate)

        self._assert_candidate_catalog_rejected(candidate)

    def test_catalog_rejects_rebound_non_distinct_external_bindings(self) -> None:
        def duplicate_dataset_lock_id(candidate: dict[str, object]) -> None:
            dataset = candidate["dataset_lock"]
            official = candidate["official_image_source_lock"]
            assert isinstance(dataset, dict)
            assert isinstance(official, dict)
            dataset["lock_id"] = official["lock_id"]

        def duplicate_dataset_lock_hash(candidate: dict[str, object]) -> None:
            dataset = candidate["dataset_lock"]
            official = candidate["official_image_source_lock"]
            assert isinstance(dataset, dict)
            assert isinstance(official, dict)
            dataset["lock_sha256"] = official["lock_sha256"]

        def duplicate_image_id(candidate: dict[str, object]) -> None:
            roles = candidate["roles"]
            assert isinstance(roles, dict)
            worker = roles["worker"]
            evaluator = roles["evaluator"]
            assert isinstance(worker, dict)
            assert isinstance(evaluator, dict)
            worker_image = worker["image"]
            evaluator_image = evaluator["image"]
            assert isinstance(worker_image, dict)
            assert isinstance(evaluator_image, dict)
            evaluator_image["local_image_id"] = worker_image["local_image_id"]

        def duplicate_image_provenance(candidate: dict[str, object]) -> None:
            roles = candidate["roles"]
            assert isinstance(roles, dict)
            worker = roles["worker"]
            evaluator = roles["evaluator"]
            assert isinstance(worker, dict)
            assert isinstance(evaluator, dict)
            worker_image = worker["image"]
            evaluator_image = evaluator["image"]
            assert isinstance(worker_image, dict)
            assert isinstance(evaluator_image, dict)
            evaluator_image["provenance_sha256"] = worker_image["provenance_sha256"]

        def duplicate_component_binding(candidate: dict[str, object]) -> None:
            candidate["adapter_sha256"] = candidate["probe_sha256"]

        mutations = (
            duplicate_dataset_lock_id,
            duplicate_dataset_lock_hash,
            duplicate_image_id,
            duplicate_image_provenance,
            duplicate_component_binding,
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate.__name__):
                candidate = _candidate()
                mutate(candidate)
                _reidentify_and_resign(candidate)
                self._assert_candidate_catalog_rejected(candidate)

    def test_real_axios_image_labels_and_environment_fixture_is_accepted(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            _write_candidates(candidates, _candidate())
            client = FakeDockerClient()
            service = _service(client, candidates, root / "operations")
            try:
                trusted = service.catalog.candidate(CANDIDATE_ID)
                self.assertEqual(trusted.instance_id, AXIOS_SMOKE_INSTANCE_ID)
                self.assertEqual(trusted.base_commit, AXIOS_SMOKE_BASE_COMMIT)
                self.assertEqual(trusted.probe_sha256, PROBE_SHA256)
                self.assertEqual(trusted.sanitizer_sha256, SANITIZER_SHA256)
                image = client.images.get(WORKER_IMAGE_ID)
                config = image.attrs["Config"]
                assert isinstance(config, dict)
                environment = config["Env"]
                labels = config["Labels"]
                assert isinstance(environment, list)
                assert isinstance(labels, dict)
                self.assertEqual(
                    [entry.split("=", 1)[0] for entry in environment],
                    ["PATH", "TZ", "CHROME_BIN", "CHROME_PATH", "HOME"],
                )
                self.assertEqual(
                    labels["io.repofixlab.role-probe-sha256"], PROBE_SHA256
                )
                self.assertEqual(
                    labels["io.repofixlab.sanitizer-sha256"], SANITIZER_SHA256
                )
                self.assertEqual(
                    labels["io.repofixlab.instance-id"], AXIOS_SMOKE_INSTANCE_ID
                )
                self.assertEqual(
                    labels["io.repofixlab.base-commit"], AXIOS_SMOKE_BASE_COMMIT
                )
                self.assertEqual(
                    FACTORY_IMAGE_ENVIRONMENT_ALLOWLIST,
                    (
                        "CHROME_BIN",
                        "CHROME_PATH",
                        "DEBIAN_FRONTEND",
                        "HOME",
                        "LANG",
                        "LC_ALL",
                        "NVM_DIR",
                        "PATH",
                        "TZ",
                    ),
                )
            finally:
                service.close()

    def test_startup_rejects_real_axios_image_label_binding_drift(self) -> None:
        labels = (
            "io.repofixlab.role-probe-sha256",
            "io.repofixlab.sanitizer-sha256",
            "io.repofixlab.instance-id",
            "io.repofixlab.base-commit",
        )
        for label in labels:
            with self.subTest(label=label):
                with TemporaryDirectory() as temporary:
                    root = Path(temporary).resolve()
                    candidates = root / "candidates"
                    _write_candidates(candidates, _candidate())
                    client = FakeDockerClient()
                    client.images = _ImageLabelDriftImages(
                        client.images, label, "drifted"
                    )
                    with self.assertRaises(CandidateCatalogError):
                        _service(client, candidates, root / "operations")
                    self.assertEqual(len(client.containers.run_calls), 0)

    def test_catalog_and_startup_reject_writable_tampered_or_drifting_inputs(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            _write_candidates(candidates, _candidate())
            schema_path = SCHEMA_DIRECTORY / "task-environment-candidate.schema.json"
            with self.assertRaises(CandidateCatalogError):
                TrustedCandidateCatalog.load(
                    candidates,
                    schema_path,
                    read_only_check=lambda _path: False,
                )

        invalid_candidates = []
        tampered = _candidate()
        roles = tampered["roles"]
        assert isinstance(roles, dict)
        worker = roles["worker"]
        assert isinstance(worker, dict)
        worker["command"] = ["sh"]
        invalid_candidates.append(tampered)
        escaped = _candidate()
        roles = escaped["roles"]
        assert isinstance(roles, dict)
        worker = roles["worker"]
        assert isinstance(worker, dict)
        filesystem = worker["filesystem_profile"]
        assert isinstance(filesystem, dict)
        filesystem["writable_mounts"] = [
            {"type": "volume", "destination": "/host", "read_write": True}
        ]
        _resign(escaped)
        invalid_candidates.append(escaped)
        for invalid in invalid_candidates:
            with self.subTest(candidate=invalid):
                with TemporaryDirectory() as temporary:
                    root = Path(temporary).resolve()
                    candidates = root / "candidates"
                    _write_candidates(candidates, invalid)
                    with self.assertRaises(CandidateCatalogError):
                        _catalog(candidates)

        for environment in ("OPENAI_API_KEY=secret", "UNLOCKED_VALUE=1"):
            with self.subTest(environment=environment):
                with TemporaryDirectory() as temporary:
                    root = Path(temporary).resolve()
                    candidates = root / "candidates"
                    _write_candidates(candidates, _candidate())
                    client = FakeDockerClient()
                    client.images = _EnvironmentDriftImages(client.images, environment)
                    with self.assertRaises(CandidateCatalogError):
                        _service(client, candidates, root / "operations")
                    self.assertEqual(len(client.containers.run_calls), 0)

    def test_controller_fixed_policy_is_not_supplied_by_candidate(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            _write_candidates(candidates, _candidate())
            catalog = _catalog(candidates)
            definition = catalog.candidate(CANDIDATE_ID).definition

            for policy in (definition.worker, definition.evaluator):
                self.assertEqual(policy.command, FACTORY_ROLE_COMMAND)
                self.assertEqual(
                    policy.allowed_image_environment_names,
                    FACTORY_IMAGE_ENVIRONMENT_ALLOWLIST,
                )
                self.assertEqual(
                    [(mount.target, mount.options) for mount in policy.tmpfs],
                    [("/tmp", FACTORY_TMPFS_OPTIONS["/tmp"])],
                )
            self.assertNotEqual(definition.candidate_sha256, CANDIDATE_SHA256)

    def test_http_report_redacts_internal_docker_exception_text(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            candidates = root / "candidates"
            _write_candidates(candidates, _candidate())
            client = FakeDockerClient("run")
            service = _service(client, candidates, root / "operations")
            try:
                with _LiveServer(service) as server:
                    status, _headers, report = server.post(
                        {
                            "operation_id": "operation-1",
                            "candidate_id": CANDIDATE_ID,
                            "instance_id": AXIOS_SMOKE_INSTANCE_ID,
                        }
                    )
                self.assertEqual(status, http.client.OK)
                rendered = json.dumps(report)
                self.assertNotIn("injected", rendered)
                self.assertNotIn("RuntimeError", rendered)
                self.assertIn("worker:create:failed", rendered)
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
