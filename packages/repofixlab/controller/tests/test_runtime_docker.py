from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
from tempfile import TemporaryDirectory
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIRECTORY = PACKAGE_ROOT / "schemas" / "v1"
DATASET_LOCK_PATH = (
    PACKAGE_ROOT / "configs" / "runtime" / "axios-5892" / "dataset-lock.json"
)
os.environ["REPOFIXLAB_SCHEMA_PATH"] = str(
    SCHEMA_DIRECTORY / "controller-bootstrap-health.schema.json"
)
sys.path.insert(0, str(PACKAGE_ROOT / "controller" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from repofixlab_controller.runtime_docker import (  # noqa: E402
    DockerRuntimeBackend,
    RUNTIME_EVALUATOR_ARTIFACTS,
    RUNTIME_PRIVATE_VOLUME,
    RuntimeDockerConfiguration,
    RuntimeDockerError,
    evaluator_kernel_aggregate,
)
from repofixlab_controller.runtime_journal import (  # noqa: E402
    RuntimeOperationJournal,
    runtime_request_sha256,
)
from repofixlab_controller.runtime_service import (  # noqa: E402
    RuntimeOperationService,
)
from test_container_factory import FakeImages  # noqa: E402
from test_factory_service import (  # noqa: E402
    _candidate,
    _catalog,
    _reidentify_and_resign,
    _write_candidates,
)


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


def _tar_file(name: str, content: bytes) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        info = tarfile.TarInfo(name)
        info.size = len(content)
        info.mode = 0o444
        archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def _archive_files(content: bytes) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                raise AssertionError("runtime archive file could not be read")
            files[member.name] = extracted.read()
    return files


@dataclass(frozen=True)
class _ExecResult:
    exit_code: int | None
    output: object


class _InjectionStream:
    def __init__(self, container: _RuntimeContainer, target: str) -> None:
        self.container = container
        self.target = target
        self._sock = self
        self.content = bytearray()
        self.closed = False

    def sendall(self, content: bytes) -> None:
        self.content.extend(content)

    def shutdown(self, direction: int) -> None:
        if direction != 1:
            raise AssertionError("stdin injection shutdown direction drifted")
        self.container.files[self.target] = bytes(self.content)
        if self.container.kind == "evaluator" and self.target.endswith("/.ready"):
            self.container.attrs = {"State": {"Status": "exited", "ExitCode": 0}}

    def close(self) -> None:
        self.closed = True


class _RuntimeVolume:
    def __init__(
        self,
        collection: _RuntimeVolumes,
        name: str,
        labels: Mapping[str, str],
        *,
        trusted: bool = False,
    ) -> None:
        self.collection = collection
        self.name = name
        self.labels = dict(labels)
        self.trusted = trusted
        self.removed = False

    def remove(self, *, force: bool = False) -> None:
        if force is not True or self.trusted:
            raise AssertionError("runtime volume removal violated policy")
        self.collection.events.append(f"volume.remove:{self.name}")
        if self.collection.fail_remove:
            raise RuntimeError("injected volume removal failure")
        self.removed = True


class _RuntimeVolumes:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.fail_remove = False
        self.created: list[_RuntimeVolume] = []
        self.private = _RuntimeVolume(
            self,
            RUNTIME_PRIVATE_VOLUME,
            {},
            trusted=True,
        )

    def get(self, name: str) -> _RuntimeVolume:
        self.events.append(f"volume.get:{name}")
        if name != RUNTIME_PRIVATE_VOLUME:
            raise KeyError(name)
        return self.private

    def create(
        self,
        *,
        name: str,
        labels: Mapping[str, str],
    ) -> _RuntimeVolume:
        if type(labels) is not dict:
            raise AssertionError("docker-py volume labels must be a dictionary")
        if name == RUNTIME_PRIVATE_VOLUME:
            raise AssertionError("trusted private volume must never be created")
        volume = _RuntimeVolume(self, name, labels)
        self.created.append(volume)
        self.events.append(f"volume.create:{name}")
        return volume

    def list(self, *, filters: Mapping[str, object]) -> list[_RuntimeVolume]:
        attempt_id = _attempt_filter(filters)
        return [
            volume
            for volume in self.created
            if not volume.removed
            and volume.labels.get("io.repofixlab.runtime.attempt-id") == attempt_id
        ]


class _RuntimeContainer:
    def __init__(
        self,
        collection: _RuntimeContainers,
        container_id: str,
        kind: str,
        labels: Mapping[str, str],
        command: list[str],
    ) -> None:
        self.collection = collection
        self.id = container_id
        self.kind = kind
        self.labels = dict(labels)
        self.command = list(command)
        self.removed = False
        self.files: dict[str, bytes] = {}
        self.attrs: dict[str, object] = {
            "State": {"Status": "running", "ExitCode": 0}
        }
        self.artifacts: dict[str, bytes] = {}
        if kind == "evaluator":
            arguments = command[3:]
            identities = {
                option: arguments[arguments.index(option) + 1]
                for option in ("--run-id", "--attempt-id", "--job-id", "--evaluation-id")
            }
            self.artifacts = {
                "evaluation.json": _canonical_bytes(
                    {
                        "schema_version": "v1",
                        "resolved": True,
                        **{name[2:].replace("-", "_"): value for name, value in identities.items()},
                    }
                ),
                "evaluator.log": b"strict fake evaluator completed\n",
                "patch-apply.json": _canonical_bytes(
                    {"schema_version": "v1", "applied": True}
                ),
            }

    def put_archive(self, path: str, content: bytes) -> bool:
        files = _archive_files(content)
        self.collection.events.append(f"container.put:{self.kind}:{path}")
        self.files.update({f"{path.rstrip('/')}/{name}": value for name, value in files.items()})
        if self.kind == "evaluator":
            if path != "/tmp" or not any(name.endswith("/.ready") for name in files):
                raise AssertionError("evaluator kernel injection drifted")
            self.attrs = {"State": {"Status": "exited", "ExitCode": 0}}
        return True

    def exec_run(self, command: list[str], **kwargs: object) -> _ExecResult:
        if kwargs.get("socket") is True:
            expected_injection_keys = {
                "stdout",
                "stderr",
                "stdin",
                "tty",
                "privileged",
                "user",
                "environment",
                "workdir",
                "socket",
                "demux",
            }
            if set(kwargs) != expected_injection_keys:
                raise AssertionError("runtime stdin injection controls drifted")
            if (
                kwargs["stdout"] is not False
                or kwargs["stderr"] is not False
                or kwargs["stdin"] is not True
                or kwargs["tty"] is not False
                or kwargs["privileged"] is not False
                or kwargs["workdir"] != "/testbed"
                or kwargs["demux"] is not False
            ):
                raise AssertionError("runtime stdin injection safety policy drifted")
            if len(command) != 7 or command[:2] != ["python3", "-c"]:
                raise AssertionError("runtime stdin writer argv drifted")
            target = f"{command[3].rstrip('/')}/{command[4]}"
            self.collection.events.append(f"container.inject:{self.kind}:{target}")
            return _ExecResult(None, _InjectionStream(self, target))
        expected_keys = {
            "stdout",
            "stderr",
            "stdin",
            "tty",
            "privileged",
            "user",
            "environment",
            "workdir",
            "demux",
        }
        if set(kwargs) != expected_keys:
            raise AssertionError("runtime exec controls drifted")
        if (
            kwargs["stdout"] is not True
            or kwargs["stderr"] is not True
            or kwargs["stdin"] is not False
            or kwargs["tty"] is not False
            or kwargs["privileged"] is not False
            or kwargs["workdir"] != "/testbed"
            or kwargs["demux"] is not True
        ):
            raise AssertionError("runtime exec safety policy drifted")
        self.collection.events.append(f"container.exec:{self.kind}")
        if len(command) == 4 and "descriptor = os.open(sys.argv[1]" in command[2]:
            content = self.files[command[3]]
            identity = f"{len(content)}:{hashlib.sha256(content).hexdigest()}\n"
            return _ExecResult(0, (identity.encode("ascii"), b""))
        if len(command) == 7 and "os.link(source, target" in command[2]:
            content = self.files.pop(command[3])
            if len(content) != int(command[5]) or hashlib.sha256(content).hexdigest() != command[6]:
                raise AssertionError("runtime ready marker identity drifted")
            self.files[command[4]] = content
            if self.kind == "evaluator":
                self.attrs = {"State": {"Status": "exited", "ExitCode": 0}}
            return _ExecResult(0, ((command[6] + "\n").encode("ascii"), b""))
        if command[-1:] == ["self-check"]:
            entries = []
            for name in ("runtime_tools.py", "runtime_worker_entry.py"):
                content = self.files[f"/tmp/repofixlab-runtime-worker/{name}"]
                entries.append(
                    {
                        "path": name,
                        "bytes": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                )
            aggregate = hashlib.sha256(
                _canonical_bytes({"files": entries})
            ).hexdigest()
            return _ExecResult(
                0,
                (
                    _canonical_bytes(
                        {
                            "schema_version": "v1",
                            "response_type": "runtime_worker_self_check",
                            "aggregate_sha256": aggregate,
                        }
                    ),
                    b"",
                ),
            )
        if len(command) == 4 and command[2] == "tool":
            request = json.loads(base64.b64decode(command[3], validate=True))
            tool = request["tool"]
            return _ExecResult(
                0,
                (
                    _canonical_bytes(
                        {
                            "schema_version": "v1",
                            "response_type": "runtime_worker_tool_result",
                            "result": {
                                "tool": tool,
                                "exit_code": 0,
                                "stdout": "strict fake output\n",
                                "stderr": "",
                                "truncated": False,
                                "timed_out": False,
                                "duration_ms": 1,
                            },
                        }
                    ),
                    b"",
                ),
            )
        if command[-1:] == ["snapshot"]:
            patch = b"diff --git a/x b/x\n"
            return _ExecResult(
                0,
                (
                    _canonical_bytes(
                        {
                            "schema_version": "v1",
                            "response_type": "runtime_worker_snapshot",
                            "patch_base64": base64.b64encode(patch).decode("ascii"),
                            "base_commit": "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b",
                            "base_tree": "1" * 40,
                            "candidate_tree": "2" * 40,
                            "files": [{"path": "x", "status": "M"}],
                            "policy": {"status": "pass", "violations": []},
                        }
                    ),
                    b"",
                ),
            )
        if self.kind == "seed" and "hashlib" in str(command):
            patch = self.files["/run/repofixlab/input/candidate.patch"]
            return _ExecResult(
                0,
                ((hashlib.sha256(patch).hexdigest() + "\n").encode("ascii"), b""),
            )
        raise AssertionError(f"unexpected runtime exec: {command!r}")

    def get_archive(self, path: str) -> tuple[list[bytes], Mapping[str, object]]:
        name = Path(path).name
        if name not in self.artifacts:
            raise FileNotFoundError(path)
        return [_tar_file(name, self.artifacts[name])], {"name": name}

    def reload(self) -> None:
        self.collection.events.append(f"container.reload:{self.kind}")

    def remove(self, *, force: bool = False) -> None:
        if force is not True:
            raise AssertionError("runtime container removal must be forced")
        self.collection.events.append(f"container.remove:{self.kind}")
        self.removed = True


class _RuntimeContainers:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.created: list[_RuntimeContainer] = []
        self.run_calls: list[tuple[str, list[str], dict[str, object]]] = []

    def run(
        self,
        image: str,
        command: list[str],
        **kwargs: object,
    ) -> _RuntimeContainer:
        expected_keys = {
            "entrypoint",
            "name",
            "detach",
            "remove",
            "auto_remove",
            "platform",
            "network_mode",
            "read_only",
            "cap_drop",
            "cap_add",
            "security_opt",
            "privileged",
            "devices",
            "ports",
            "tty",
            "stdin_open",
            "user",
            "nano_cpus",
            "mem_limit",
            "memswap_limit",
            "pids_limit",
            "volumes",
            "tmpfs",
            "environment",
            "labels",
        }
        if set(kwargs) != expected_keys:
            raise AssertionError("runtime Docker launch controls drifted")
        if (
            kwargs["detach"] is not True
            or kwargs["remove"] is not False
            or kwargs["auto_remove"] is not False
            or kwargs["platform"] != "linux/amd64"
            or kwargs["network_mode"] != "none"
            or kwargs["read_only"] is not True
            or kwargs["cap_drop"] != ["ALL"]
            or kwargs["cap_add"] != []
            or kwargs["security_opt"] != ["no-new-privileges:true"]
            or kwargs["privileged"] is not False
            or kwargs["devices"] != []
            or kwargs["ports"] != {}
            or kwargs["tty"] is not False
            or kwargs["stdin_open"] is not False
            or kwargs["entrypoint"] != ["python3"]
        ):
            raise AssertionError("runtime Docker safety policy drifted")
        volumes = kwargs["volumes"]
        if not isinstance(volumes, dict) or any("/" in source for source in volumes):
            raise AssertionError("host bind mounts are forbidden")
        labels = kwargs["labels"]
        if not isinstance(labels, dict) or labels.get("io.repofixlab.runtime.managed") != "true":
            raise AssertionError("runtime managed labels drifted")
        name = str(kwargs["name"])
        kind = "worker"
        if "evaluator-seed" in name:
            kind = "seed"
        elif "evaluator-container" in name:
            kind = "evaluator"
        if kind != "worker" and any(
            item.kind == "worker" and not item.removed for item in self.created
        ):
            raise AssertionError("evaluator started before worker zero residual cleanup")
        container = _RuntimeContainer(
            self,
            f"{len(self.created) + 1:064x}",
            kind,
            labels,
            command,
        )
        self.created.append(container)
        self.run_calls.append((image, list(command), dict(kwargs)))
        self.events.append(f"container.run:{kind}")
        return container

    def list(
        self,
        *,
        all: bool = False,
        filters: Mapping[str, object],
    ) -> list[_RuntimeContainer]:
        if all is not True:
            raise AssertionError("runtime cleanup must include stopped containers")
        attempt_id = _attempt_filter(filters)
        return [
            container
            for container in self.created
            if not container.removed
            and container.labels.get("io.repofixlab.runtime.attempt-id") == attempt_id
        ]


class _RuntimeDockerClient:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.images = FakeImages(self.events, None)
        self.volumes = _RuntimeVolumes(self.events)
        self.containers = _RuntimeContainers(self.events)


def _attempt_filter(filters: Mapping[str, object]) -> str:
    labels = filters.get("label")
    if not isinstance(labels, list):
        raise AssertionError("runtime cleanup labels are malformed")
    prefix = "io.repofixlab.runtime.attempt-id="
    matches = [value for value in labels if isinstance(value, str) and value.startswith(prefix)]
    if len(matches) != 1:
        raise AssertionError("runtime attempt cleanup filter drifted")
    return matches[0][len(prefix) :]


def _task_environment_lock(candidate: object) -> dict[str, object]:
    definition = candidate.definition
    verification = {
        "factory_probe_passed": True,
        "factory_probe_report_sha256": "4" * 64,
        "equivalence_passed": True,
        "security_profile_passed": True,
        "evidence_sha256": "5" * 64,
        "completed_at": "2026-07-18T12:00:00.000Z",
    }
    value: dict[str, object] = {
        "schema_version": "v1",
        "lock_type": "task_environment",
        "instance_id": candidate.instance_id,
        "candidate_id": candidate.candidate_id,
        "candidate_sha256": candidate.candidate_sha256,
        "dataset_lock_id": candidate.dataset_lock_id,
        "official_image_source_lock_id": candidate.official_image_source_lock_id,
        "source_image": {
            "repository_digest": "example.invalid/task@sha256:" + "6" * 64,
            "local_image_id": "sha256:" + "6" * 64,
            "platform": "linux/amd64",
        },
        "worker_image": {
            "local_image_id": definition.worker.image_id,
            "platform": "linux/amd64",
            "provenance_sha256": definition.worker.provenance_sha256,
        },
        "evaluator_image": {
            "local_image_id": definition.evaluator.image_id,
            "platform": "linux/amd64",
            "provenance_sha256": definition.evaluator.provenance_sha256,
        },
        "resource_profile": {
            "cpu_count": definition.worker.nano_cpus / 1_000_000_000,
            "memory_bytes": definition.worker.memory_bytes,
            "pids_limit": definition.worker.pids_limit,
            "network_mode": "none",
            "read_only_root_filesystem": True,
        },
        "filesystem_profile_sha256": candidate.filesystem_profile_sha256,
        "sanitizer_sha256": candidate.sanitizer_sha256,
        "adapter_sha256": candidate.adapter_sha256,
        "verification": verification,
        "created_at": "2026-07-18T12:00:00.000Z",
    }
    semantic = dict(value)
    semantic["verification"] = {
        key: item for key, item in verification.items() if key != "completed_at"
    }
    semantic.pop("created_at")
    seal = hashlib.sha256(_canonical_bytes(semantic)).hexdigest()
    value["seal_sha256"] = seal
    value["lock_id"] = f"task-environment-v1-axios-5892-{seal[:16]}"
    return value


def _backend_fixture(root: Path) -> tuple[DockerRuntimeBackend, _RuntimeDockerClient, object]:
    dataset_raw = DATASET_LOCK_PATH.read_bytes()
    dataset_lock = json.loads(dataset_raw)
    candidate_value = _candidate()
    candidate_value["dataset_lock"] = {
        "lock_id": dataset_lock["lock_id"],
        "lock_sha256": hashlib.sha256(dataset_raw).hexdigest(),
    }
    _reidentify_and_resign(candidate_value)
    candidate_directory = root / "candidates"
    _write_candidates(candidate_directory, candidate_value)
    catalog = _catalog(candidate_directory)
    candidate = catalog.candidate(str(candidate_value["candidate_id"]))
    task_lock_path = root / "task-environment-lock.json"
    task_lock_path.write_text(
        json.dumps(_task_environment_lock(candidate), sort_keys=True),
        encoding="utf-8",
    )
    kernel_root = root / "kernel"
    kernel_root.mkdir()
    (kernel_root / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")
    configuration = RuntimeDockerConfiguration(
        task_environment_lock_path=task_lock_path,
        task_environment_lock_schema_path=(
            SCHEMA_DIRECTORY / "task-environment-lock.schema.json"
        ),
        dataset_lock_path=DATASET_LOCK_PATH,
        dataset_lock_schema_path=SCHEMA_DIRECTORY / "dataset-lock.schema.json",
        evaluator_kernel_root=kernel_root,
        evaluator_kernel_sha256=evaluator_kernel_aggregate(kernel_root),
    )
    client = _RuntimeDockerClient()
    backend = DockerRuntimeBackend(
        client,
        catalog,
        configuration,
        read_only_check=lambda _path: True,
    )
    return backend, client, candidate


class _IdFactory:
    def __init__(self) -> None:
        self.value = 0

    def __call__(self) -> str:
        self.value += 1
        return f"{self.value:032x}"


def _write_request(
    request_type: str,
    attempt_id: str,
    operation_id: str,
    **payload: object,
) -> dict[str, object]:
    canonical = {
        "schema_version": "v1",
        "request_type": request_type,
        "attempt_id": attempt_id,
        "operation_id": operation_id,
        **payload,
    }
    return {**canonical, "request_sha256": runtime_request_sha256(canonical)}


class DockerRuntimeBackendTests(unittest.TestCase):
    def test_locked_worker_snapshot_and_fresh_evaluator_lifecycle(self) -> None:
        with TemporaryDirectory() as temporary:
            backend, client, candidate = _backend_fixture(Path(temporary).resolve())
            manifest = backend.preflight(candidate.candidate_id, candidate.instance_id)
            self.assertEqual(manifest.task_environment_lock_sha256, backend._task_lock.seal_sha256)
            worker = backend.prepare_worker(
                "attempt-production",
                candidate.candidate_id,
                candidate.instance_id,
            )
            result = backend.execute_tool(worker, "repo_read", {"path": "README.md"})
            self.assertEqual(result.tool, "repo_read")
            snapshot = backend.snapshot_patch(worker)
            self.assertEqual(snapshot.base_commit, candidate.base_commit)
            self.assertEqual(snapshot.policy_status, "pass")
            self.assertTrue(backend.destroy_worker(worker).clean)

            job = backend.start_evaluation(
                "attempt-production",
                "run-production",
                "job-production",
                "evaluation-production",
                candidate.candidate_id,
                candidate.instance_id,
                snapshot.patch,
            )
            status = backend.get_job(job)
            self.assertEqual((status.status, status.resolved), ("completed", True))
            artifacts = backend.get_artifacts(job)
            self.assertEqual(set(artifacts), set(RUNTIME_EVALUATOR_ARTIFACTS))
            self.assertTrue(backend.acknowledge_artifacts(job).clean)
            self.assertFalse(client.volumes.private.removed)
            self.assertEqual(client.containers.list(all=True, filters={"label": ["io.repofixlab.runtime.managed=true", "io.repofixlab.runtime.attempt-id=attempt-production"]}), [])
            self.assertEqual(client.volumes.list(filters={"label": ["io.repofixlab.runtime.managed=true", "io.repofixlab.runtime.attempt-id=attempt-production"]}), [])
            evaluator_run = next(
                call for call in client.containers.run_calls if "evaluator-container" in str(call[2]["name"])
            )
            evaluator_volumes = evaluator_run[2]["volumes"]
            self.assertEqual(evaluator_volumes[RUNTIME_PRIVATE_VOLUME]["mode"], "ro")
            self.assertNotIn(RUNTIME_PRIVATE_VOLUME, client.volumes.created)

    def test_abort_retries_residual_cleanup_and_releases_capacity(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend, client, candidate = _backend_fixture(root)
            service = RuntimeOperationService(
                backend,
                RuntimeOperationJournal(root / "operations"),
                id_factory=_IdFactory(),
            )
            try:
                attempt_id = "attempt-abort-production"
                service.preflight(
                    _write_request(
                        "runtime_preflight",
                        attempt_id,
                        "operation-preflight",
                        candidate_id=candidate.candidate_id,
                        instance_id=candidate.instance_id,
                    )
                )
                service.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        attempt_id,
                        "operation-prepare",
                        candidate_id=candidate.candidate_id,
                        instance_id=candidate.instance_id,
                    )
                )
                client.volumes.fail_remove = True
                blocked = service.abort_attempt(
                    _write_request(
                        "runtime_abort_attempt",
                        attempt_id,
                        "operation-abort-blocked",
                    )
                ).response
                self.assertEqual(blocked["status"], "blocked")
                self.assertGreater(blocked["cleanup"]["residual_volume_count"], 0)

                client.volumes.fail_remove = False
                aborted = service.abort_attempt(
                    _write_request(
                        "runtime_abort_attempt",
                        attempt_id,
                        "operation-abort-retry",
                    )
                ).response
                self.assertEqual(aborted["status"], "aborted")
                self.assertTrue(aborted["cleanup"]["clean"])
                next_attempt = "attempt-after-production-abort"
                service.preflight(
                    _write_request(
                        "runtime_preflight",
                        next_attempt,
                        "operation-next-preflight",
                        candidate_id=candidate.candidate_id,
                        instance_id=candidate.instance_id,
                    )
                )
                prepared = service.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        next_attempt,
                        "operation-next-prepare",
                        candidate_id=candidate.candidate_id,
                        instance_id=candidate.instance_id,
                    )
                )
                self.assertEqual(prepared.response["status"], "prepared")
            finally:
                service.close()

    def test_startup_rejects_kernel_drift_before_resource_mutation(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend, client, _candidate_value = _backend_fixture(root)
            configuration = backend._configuration
            drifted = RuntimeDockerConfiguration(
                task_environment_lock_path=configuration.task_environment_lock_path,
                task_environment_lock_schema_path=configuration.task_environment_lock_schema_path,
                dataset_lock_path=configuration.dataset_lock_path,
                dataset_lock_schema_path=configuration.dataset_lock_schema_path,
                evaluator_kernel_root=configuration.evaluator_kernel_root,
                evaluator_kernel_sha256="0" * 64,
            )
            with self.assertRaises(RuntimeDockerError):
                DockerRuntimeBackend(
                    client,
                    backend._catalog,
                    drifted,
                    read_only_check=lambda _path: True,
                )
            self.assertEqual(client.containers.run_calls, [])
            self.assertEqual(client.volumes.created, [])


if __name__ == "__main__":
    unittest.main()
