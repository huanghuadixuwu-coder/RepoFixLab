from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import time
import unittest
import urllib.error
import urllib.request

import uvicorn


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIRECTORY = PACKAGE_ROOT / "schemas" / "v1"
os.environ["REPOFIXLAB_SCHEMA_PATH"] = str(
    SCHEMA_DIRECTORY / "controller-bootstrap-health.schema.json"
)
sys.path.insert(0, str(PACKAGE_ROOT / "controller" / "src"))

from repofixlab_controller.app import create_app  # noqa: E402
from repofixlab_controller.runtime_journal import (  # noqa: E402
    RuntimeOperationJournal,
    runtime_request_sha256,
)
from repofixlab_controller.runtime_service import (  # noqa: E402
    RuntimeCapacityBusy,
    RuntimeCleanupResult,
    RuntimeInvalidState,
    RuntimeJobStatus,
    RuntimeOperationConflict,
    RuntimeOperationService,
    RuntimePreflightManifest,
    RuntimeRequestRejected,
    RuntimeServiceUnavailable,
)
from repofixlab_controller.runtime_tools import (  # noqa: E402
    RUNTIME_TOOL_NAMES,
    RepositoryToolExecutor,
    RuntimeSnapshotEvidence,
    RuntimeSnapshotFile,
    RuntimeToolError,
    RuntimeToolName,
    RuntimeToolResult,
    TOOL_OUTPUT_LIMIT_BYTES,
)


CANDIDATE_ID = "task-environment-candidate-v1-axios-5892-test"
INSTANCE_ID = "axios__axios-5892"
POLICY_SHA256 = "8" * 64
TASK_ENVIRONMENT_LOCK_ID = "task-environment-v1-axios-5892-1234567890abcdef"
TASK_ENVIRONMENT_LOCK_SHA256 = "9" * 64
CANDIDATE_SHA256 = "7" * 64
BASE_COMMIT = "a" * 40


def _git(repository: Path, *arguments: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *arguments],
        cwd=repository,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )


def _repository(root: Path) -> Path:
    repository = root / "repository"
    repository.mkdir()
    _git(repository, "init", "--quiet")
    _git(repository, "config", "user.email", "runtime@example.invalid")
    _git(repository, "config", "user.name", "RepoFixLab Runtime Test")
    (repository / "README.md").write_text("base\n", encoding="utf-8")
    _git(repository, "add", "README.md")
    _git(repository, "commit", "--quiet", "-m", "base")
    return repository.resolve()


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


@dataclass(frozen=True)
class _Worker:
    attempt_id: str
    executor: RepositoryToolExecutor
    generation: int


@dataclass(frozen=True)
class _Job:
    attempt_id: str
    patch: bytes
    generation: int
    run_id: str
    job_id: str
    evaluation_id: str


class FakeDockerRuntimeBackend:
    def __init__(
        self,
        repository: Path,
        *,
        recovery_cleanup: RuntimeCleanupResult | None = None,
    ) -> None:
        self.repository = repository
        self.recovery_cleanup = recovery_cleanup or RuntimeCleanupResult(0, 0)
        self.events: list[str] = []
        self.workers: dict[str, _Worker] = {}
        self.jobs: dict[str, _Job] = {}
        self.snapshot_policy_fail = False
        self._generation = 0

    def preflight(
        self, candidate_id: str, instance_id: str
    ) -> RuntimePreflightManifest:
        self.events.append(f"preflight:{candidate_id}:{instance_id}")
        return RuntimePreflightManifest(
            manifest_id="runtime-manifest-v1-axios-5892",
            candidate_id=candidate_id,
            instance_id=instance_id,
            policy_sha256=POLICY_SHA256,
            task_environment_lock_id=TASK_ENVIRONMENT_LOCK_ID,
            task_environment_lock_sha256=TASK_ENVIRONMENT_LOCK_SHA256,
            candidate_sha256=CANDIDATE_SHA256,
            base_commit=BASE_COMMIT,
        )

    def prepare_worker(
        self, attempt_id: str, candidate_id: str, instance_id: str
    ) -> object:
        if candidate_id != CANDIDATE_ID or instance_id != INSTANCE_ID:
            raise AssertionError("backend received an unlocked task")
        self._generation += 1
        worker = _Worker(
            attempt_id,
            RepositoryToolExecutor(self.repository),
            self._generation,
        )
        self.workers[attempt_id] = worker
        self.events.append(f"worker.prepare:{attempt_id}:{worker.generation}")
        return worker

    def execute_tool(
        self,
        worker: object,
        tool: RuntimeToolName,
        arguments: Mapping[str, object],
    ) -> RuntimeToolResult:
        if not isinstance(worker, _Worker) or self.workers.get(worker.attempt_id) is not worker:
            raise AssertionError("tool did not receive the active worker")
        self.events.append(f"tool:{worker.attempt_id}:{tool}")
        return worker.executor.execute(tool, arguments)

    def snapshot_patch(self, worker: object) -> RuntimeSnapshotEvidence:
        if not isinstance(worker, _Worker) or self.workers.get(worker.attempt_id) is not worker:
            raise AssertionError("snapshot did not receive the active worker")
        self.events.append(f"worker.snapshot:{worker.attempt_id}")
        snapshot = worker.executor.snapshot_evidence()
        files = snapshot.files
        violations = snapshot.policy_violations
        if self.snapshot_policy_fail:
            files = (
                RuntimeSnapshotFile(path="policy-failure.txt", status="U"),
                *files,
            )
            violations = ("changed_status_invalid",)
        return RuntimeSnapshotEvidence(
            patch=snapshot.patch,
            base_commit=BASE_COMMIT,
            base_tree=snapshot.base_tree,
            candidate_tree=snapshot.candidate_tree,
            files=files,
            policy_violations=violations,
        )

    def destroy_worker(self, worker: object) -> RuntimeCleanupResult:
        if not isinstance(worker, _Worker) or self.workers.get(worker.attempt_id) is not worker:
            raise AssertionError("destroy did not receive the active worker")
        self.events.append(f"worker.destroy:{worker.attempt_id}:{worker.generation}")
        del self.workers[worker.attempt_id]
        return RuntimeCleanupResult(0, 0)

    def start_evaluation(
        self,
        attempt_id: str,
        run_id: str,
        job_id: str,
        evaluation_id: str,
        candidate_id: str,
        instance_id: str,
        patch: bytes,
    ) -> object:
        if attempt_id in self.workers:
            raise AssertionError("evaluator started before worker destruction")
        if candidate_id != CANDIDATE_ID or instance_id != INSTANCE_ID:
            raise AssertionError("evaluator received an unlocked task")
        self._generation += 1
        job = _Job(
            attempt_id,
            patch,
            self._generation,
            run_id,
            job_id,
            evaluation_id,
        )
        self.jobs[attempt_id] = job
        self.events.append(f"evaluation.start:{attempt_id}:{job.generation}")
        return job

    def get_job(self, job: object) -> RuntimeJobStatus:
        if not isinstance(job, _Job) or self.jobs.get(job.attempt_id) is not job:
            raise AssertionError("job lookup did not receive the fresh evaluator")
        return RuntimeJobStatus("completed", b"new.txt" in job.patch, None)

    def get_artifacts(self, job: object) -> Mapping[str, bytes]:
        if not isinstance(job, _Job) or self.jobs.get(job.attempt_id) is not job:
            raise AssertionError("artifact lookup did not receive the fresh evaluator")
        return {
            "evaluation.json": json.dumps(
                {
                    "schema_version": "v1",
                    "resolved": b"new.txt" in job.patch,
                    "patch_sha256": hashlib.sha256(job.patch).hexdigest(),
                },
                sort_keys=True,
            ).encode("utf-8"),
            "evaluator.log": b"fake evaluator completed\n",
        }

    def acknowledge_artifacts(self, job: object) -> RuntimeCleanupResult:
        if not isinstance(job, _Job) or self.jobs.get(job.attempt_id) is not job:
            raise AssertionError("ack did not receive the fresh evaluator")
        self.events.append(f"evaluation.ack:{job.attempt_id}:{job.generation}")
        del self.jobs[job.attempt_id]
        return RuntimeCleanupResult(0, 0)

    def recover_attempt(self, attempt_id: str) -> RuntimeCleanupResult:
        self.events.append(f"recover:{attempt_id}")
        self.workers.pop(attempt_id, None)
        self.jobs.pop(attempt_id, None)
        return self.recovery_cleanup


class _IdFactory:
    def __init__(self) -> None:
        self.value = 0

    def __call__(self) -> str:
        self.value += 1
        return f"{self.value:032x}"


def _service(
    backend: FakeDockerRuntimeBackend,
    journal_root: Path,
) -> RuntimeOperationService:
    return RuntimeOperationService(
        backend,
        RuntimeOperationJournal(journal_root.resolve()),
        id_factory=_IdFactory(),
    )


class _LiveServer:
    def __init__(self, service: RuntimeOperationService) -> None:
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(128)
        self.port = int(self._socket.getsockname()[1])
        config = uvicorn.Config(
            create_app(
                runtime_service=service,
                factory_service=None,
                load_factory_from_environment=False,
            ),
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
                raise RuntimeError("runtime HTTP test server did not start")
            time.sleep(0.01)
        return self

    def __exit__(self, *_args: object) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=5)
        self._socket.close()

    def request(
        self,
        method: str,
        path: str,
        body: Mapping[str, object] | None = None,
    ) -> tuple[int, Mapping[str, str], object]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=(json.dumps(body).encode("utf-8") if body is not None else None),
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return (
                    response.status,
                    dict(response.headers.items()),
                    json.loads(response.read().decode("utf-8")),
                )
        except urllib.error.HTTPError as error:
            return (
                error.code,
                dict(error.headers.items()),
                json.loads(error.read().decode("utf-8")),
            )


class RuntimeServiceTest(unittest.TestCase):
    def test_full_fake_docker_lifecycle_uses_fresh_evaluator_and_releases_capacity(
        self,
    ) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repository = _repository(root)
            backend = FakeDockerRuntimeBackend(repository)
            service = _service(backend, root / "journal")
            try:
                attempt_id = "attempt-1"
                preflight = _write_request(
                    "runtime_preflight",
                    attempt_id,
                    "operation-preflight",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
                self.assertEqual(service.preflight(preflight).response["status"], "ready")
                prepared = service.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        attempt_id,
                        "operation-prepare",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                ).response
                lease_id = str(prepared["lease_id"])

                tool_operations = (
                    (
                        "repo_edit",
                        {"path": "new.txt", "content": "needle\n"},
                    ),
                    ("repo_list", {"path": "."}),
                    ("repo_read", {"path": "new.txt"}),
                    ("repo_search", {"path": ".", "query": "needle"}),
                    (
                        "repo_exec",
                        {"argv": ["git", "status", "--short"], "timeout_ms": 5_000},
                    ),
                    ("repo_diff", {}),
                )
                tool_responses: dict[str, Mapping[str, object]] = {}
                for index, (tool, tool_input) in enumerate(tool_operations):
                    response = service.execute_tool(
                        _write_request(
                            "runtime_execute_tool",
                            attempt_id,
                            f"operation-tool-{index}",
                            lease_id=lease_id,
                            tool=tool,
                            input=tool_input,
                        )
                    ).response
                    tool_responses[tool] = response
                    self.assertEqual(response["tool"], tool)
                    self.assertEqual(response["input"], tool_input)
                diff_result = tool_responses["repo_diff"]["result"]
                assert isinstance(diff_result, Mapping)
                self.assertIn("new.txt", str(diff_result["stdout"]))

                snapshot = service.snapshot_patch(
                    _write_request(
                        "runtime_snapshot_patch",
                        attempt_id,
                        "operation-snapshot",
                        lease_id=lease_id,
                    )
                ).response
                self.assertFalse(snapshot["empty"])
                self.assertEqual(snapshot["patch_bytes"], len(base64.b64decode(str(snapshot["patch_base64"]))))
                self.assertEqual(snapshot["base_commit"], BASE_COMMIT)
                self.assertEqual(snapshot["policy"], {"status": "pass", "violations": []})
                self.assertIn({"path": "new.txt", "status": "added"}, snapshot["files"])
                self.assertEqual(
                    snapshot["base_tree"],
                    {"algorithm": "git-sha1", "value": snapshot["base_tree"]["value"]},
                )
                self.assertEqual(
                    snapshot["candidate_tree"],
                    {
                        "algorithm": "git-sha1",
                        "value": snapshot["candidate_tree"]["value"],
                    },
                )
                self.assertNotIn("patch_size_bytes", snapshot)
                self.assertEqual(_git(repository, "diff", "--cached").stdout, b"")
                destroyed = service.destroy_worker(
                    _write_request(
                        "runtime_destroy_worker",
                        attempt_id,
                        "operation-destroy",
                        lease_id=lease_id,
                    )
                ).response
                cleanup = destroyed["cleanup"]
                assert isinstance(cleanup, Mapping)
                self.assertTrue(cleanup["clean"])
                evaluation = service.start_evaluation(
                    _write_request(
                        "runtime_start_evaluation",
                        attempt_id,
                        "operation-evaluate",
                        run_id="run-1",
                        snapshot_id=snapshot["snapshot_id"],
                    )
                ).response
                job_id = str(evaluation["job_id"])
                self.assertLess(
                    next(
                        i
                        for i, event in enumerate(backend.events)
                        if event.startswith("worker.destroy")
                    ),
                    next(
                        i
                        for i, event in enumerate(backend.events)
                        if event.startswith("evaluation.start")
                    ),
                )
                self.assertEqual(service.get_job(job_id)["status"], "completed")
                artifacts = service.get_artifacts(job_id)
                self.assertEqual(len(artifacts["artifacts"]), 2)
                acknowledged = service.acknowledge_artifacts(
                    _write_request(
                        "runtime_ack_artifacts",
                        attempt_id,
                        "operation-ack",
                        job_id=job_id,
                        artifact_set_sha256=artifacts["artifact_set_sha256"],
                    )
                ).response
                self.assertEqual(acknowledged["status"], "acknowledged")

                second_attempt = "attempt-2"
                service.preflight(
                    _write_request(
                        "runtime_preflight",
                        second_attempt,
                        "operation-preflight-2",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                second = service.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        second_attempt,
                        "operation-prepare-2",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                self.assertEqual(second.response["status"], "prepared")
            finally:
                service.close()

    def test_request_hash_idempotency_conflict_and_capacity_are_fail_closed(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = FakeDockerRuntimeBackend(_repository(root))
            service = _service(backend, root / "journal")
            try:
                request = _write_request(
                    "runtime_preflight",
                    "attempt-1",
                    "operation-1",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
                first = service.preflight(request)
                replay = service.preflight(request)
                self.assertFalse(first.replayed)
                self.assertTrue(replay.replayed)
                self.assertEqual(first.response, replay.response)
                self.assertEqual(
                    len([event for event in backend.events if event.startswith("preflight:")]),
                    1,
                )
                conflict = _write_request(
                    "runtime_preflight",
                    "attempt-other",
                    "operation-1",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
                with self.assertRaises(RuntimeOperationConflict):
                    service.preflight(conflict)

                invalid_hash = dict(request)
                invalid_hash["operation_id"] = "operation-invalid-hash"
                with self.assertRaises(RuntimeRequestRejected):
                    service.preflight(invalid_hash)

                service.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        "attempt-1",
                        "operation-prepare-1",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                service.preflight(
                    _write_request(
                        "runtime_preflight",
                        "attempt-2",
                        "operation-preflight-2",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                with self.assertRaises(RuntimeCapacityBusy):
                    service.prepare_worker(
                        _write_request(
                            "runtime_prepare_worker",
                            "attempt-2",
                            "operation-prepare-2",
                            candidate_id=CANDIDATE_ID,
                            instance_id=INSTANCE_ID,
                        )
                    )
            finally:
                service.close()

    def test_policy_failed_snapshot_can_destroy_but_cannot_evaluate(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = FakeDockerRuntimeBackend(_repository(root))
            service = _service(backend, root / "journal")
            try:
                attempt_id = "attempt-policy-fail"
                service.preflight(
                    _write_request(
                        "runtime_preflight",
                        attempt_id,
                        "operation-preflight-policy-fail",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                prepared = service.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        attempt_id,
                        "operation-prepare-policy-fail",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                ).response
                backend.snapshot_policy_fail = True
                snapshot = service.snapshot_patch(
                    _write_request(
                        "runtime_snapshot_patch",
                        attempt_id,
                        "operation-snapshot-policy-fail",
                        lease_id=prepared["lease_id"],
                    )
                ).response
                self.assertEqual(
                    snapshot["policy"],
                    {"status": "fail", "violations": ["changed_status_invalid"]},
                )
                destroyed = service.destroy_worker(
                    _write_request(
                        "runtime_destroy_worker",
                        attempt_id,
                        "operation-destroy-policy-fail",
                        lease_id=prepared["lease_id"],
                    )
                ).response
                self.assertTrue(destroyed["cleanup"]["clean"])
                with self.assertRaises(RuntimeInvalidState):
                    service.start_evaluation(
                        _write_request(
                            "runtime_start_evaluation",
                            attempt_id,
                            "operation-evaluate-policy-fail",
                            run_id="run-policy-fail",
                            snapshot_id=snapshot["snapshot_id"],
                        )
                    )

                second_attempt = "attempt-after-policy-fail"
                service.preflight(
                    _write_request(
                        "runtime_preflight",
                        second_attempt,
                        "operation-preflight-after-policy-fail",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                admitted = service.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        second_attempt,
                        "operation-prepare-after-policy-fail",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                self.assertEqual(admitted.response["status"], "prepared")
            finally:
                service.close()

    def test_abort_active_attempt_is_persistent_idempotent_and_releases_capacity(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = FakeDockerRuntimeBackend(_repository(root))
            journal_root = root / "journal"
            first = _service(backend, journal_root)
            attempt_id = "attempt-abort"
            first.preflight(
                _write_request(
                    "runtime_preflight",
                    attempt_id,
                    "operation-preflight-abort",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
            )
            first.prepare_worker(
                _write_request(
                    "runtime_prepare_worker",
                    attempt_id,
                    "operation-prepare-abort",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
            )
            abort = _write_request(
                "runtime_abort_attempt",
                attempt_id,
                "operation-abort",
            )
            aborted = first.abort_attempt(abort)
            self.assertEqual(aborted.response["response_type"], "runtime_attempt_aborted")
            self.assertEqual(aborted.response["status"], "aborted")
            self.assertTrue(aborted.response["cleanup"]["clean"])
            self.assertFalse(aborted.replayed)
            self.assertTrue(first.abort_attempt(abort).replayed)
            self.assertNotIn(attempt_id, backend.workers)
            first.close()

            second = _service(backend, journal_root)
            try:
                self.assertTrue(second.abort_attempt(abort).replayed)
                self.assertEqual(
                    len([event for event in backend.events if event == f"recover:{attempt_id}"]),
                    1,
                )
                next_attempt = "attempt-after-abort"
                second.preflight(
                    _write_request(
                        "runtime_preflight",
                        next_attempt,
                        "operation-preflight-after-abort",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                prepared = second.prepare_worker(
                    _write_request(
                        "runtime_prepare_worker",
                        next_attempt,
                        "operation-prepare-after-abort",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                self.assertEqual(prepared.response["status"], "prepared")
            finally:
                second.close()

    def test_restart_recovers_active_worker_and_persists_recovered_attempt(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = FakeDockerRuntimeBackend(_repository(root))
            journal_root = root / "journal"
            first = _service(backend, journal_root)
            preflight = _write_request(
                "runtime_preflight",
                "attempt-1",
                "operation-preflight",
                candidate_id=CANDIDATE_ID,
                instance_id=INSTANCE_ID,
            )
            prepare = _write_request(
                "runtime_prepare_worker",
                "attempt-1",
                "operation-prepare",
                candidate_id=CANDIDATE_ID,
                instance_id=INSTANCE_ID,
            )
            first.preflight(preflight)
            prepared = first.prepare_worker(prepare).response
            first.close()

            second = _service(backend, journal_root)
            try:
                self.assertNotIn("attempt-1", backend.workers)
                self.assertIn("recover:attempt-1", backend.events)
                self.assertTrue(second.prepare_worker(prepare).replayed)
                with self.assertRaises(RuntimeInvalidState):
                    second.execute_tool(
                        _write_request(
                            "runtime_execute_tool",
                            "attempt-1",
                            "operation-tool-after-recovery",
                            lease_id=prepared["lease_id"],
                            tool="repo_list",
                            input={"path": "."},
                        )
                    )
            finally:
                second.close()

            third = _service(backend, journal_root)
            try:
                self.assertEqual(
                    len([event for event in backend.events if event == "recover:attempt-1"]),
                    1,
                )
            finally:
                third.close()

    def test_recovery_residuals_block_new_worker_admission(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repository = _repository(root)
            backend = FakeDockerRuntimeBackend(repository)
            journal_root = root / "journal"
            first = _service(backend, journal_root)
            first.preflight(
                _write_request(
                    "runtime_preflight",
                    "attempt-1",
                    "operation-preflight",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
            )
            first.prepare_worker(
                _write_request(
                    "runtime_prepare_worker",
                    "attempt-1",
                    "operation-prepare",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
            )
            first.close()
            backend.recovery_cleanup = RuntimeCleanupResult(1, 0)

            second = _service(backend, journal_root)
            try:
                second.preflight(
                    _write_request(
                        "runtime_preflight",
                        "attempt-2",
                        "operation-preflight-2",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                )
                with self.assertRaises(RuntimeServiceUnavailable):
                    second.prepare_worker(
                        _write_request(
                            "runtime_prepare_worker",
                            "attempt-2",
                            "operation-prepare-2",
                            candidate_id=CANDIDATE_ID,
                            instance_id=INSTANCE_ID,
                        )
                    )
            finally:
                second.close()

    def test_repository_tools_reject_escape_symlink_and_unbounded_execution(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repository = _repository(root)
            executor = RepositoryToolExecutor(repository)
            for path in ("../outside", "/etc/passwd", "sub/../../outside"):
                with self.subTest(path=path), self.assertRaises(RuntimeToolError):
                    executor.execute("repo_read", {"path": path})

            os.symlink(repository / "README.md", repository / "linked-readme")
            with self.assertRaises(RuntimeToolError):
                executor.execute("repo_read", {"path": "linked-readme"})
            with self.assertRaises(RuntimeToolError):
                executor.execute(
                    "repo_exec",
                    {"argv": ["git", "status"], "cwd": "/tmp"},
                )
            with self.assertRaises(RuntimeToolError):
                executor.execute(
                    "repo_exec",
                    {"argv": ["git", "status"], "timeout_ms": 120_001},
                )
            with self.assertRaises(RuntimeToolError):
                executor.execute("repo_exec", {"argv": ["/bin/sh"]})

            created = executor.execute(
                "repo_edit", {"path": "editable.txt", "content": "before\n"}
            )
            self.assertEqual(created.stdout, "created\teditable.txt\n")
            with self.assertRaises(RuntimeToolError):
                executor.execute(
                    "repo_edit", {"path": "editable.txt", "content": "truncated"}
                )
            (repository / "test").mkdir()
            with self.assertRaises(RuntimeToolError):
                executor.execute(
                    "repo_edit", {"path": "test/regression.js", "content": "test body\n"}
                )
            with self.assertRaises(RuntimeToolError):
                executor.execute(
                    "repo_edit", {"path": "test_case_insensitive_encoding.js", "content": "test body\n"}
                )
            os.chmod(repository / "editable.txt", 0o755)
            replaced = executor.execute(
                "repo_edit",
                {
                    "path": "editable.txt",
                    "old_text": "before\n",
                    "new_text": "after\n",
                },
            )
            self.assertEqual(replaced.stdout, "replaced\teditable.txt\n")
            self.assertEqual((repository / "editable.txt").read_text(encoding="utf-8"), "after\n")
            self.assertEqual((repository / "editable.txt").stat().st_mode & 0o777, 0o755)
            (repository / "ambiguous.txt").write_text("needle\nneedle\n", encoding="utf-8")
            with self.assertRaises(RuntimeToolError):
                executor.execute(
                    "repo_edit",
                    {"path": "ambiguous.txt", "old_text": "needle", "new_text": "replacement"},
                )

            (repository / "large.txt").write_text(
                "x" * (TOOL_OUTPUT_LIMIT_BYTES + 1024), encoding="utf-8"
            )
            result = executor.execute("repo_read", {"path": "large.txt"})
            self.assertTrue(result.truncated)
            self.assertLessEqual(len(result.stdout.encode("utf-8")), TOOL_OUTPUT_LIMIT_BYTES)
            cwd = executor.execute(
                "repo_exec",
                {"argv": ["git", "rev-parse", "--show-toplevel"]},
            )
            self.assertEqual(Path(cwd.stdout.strip()).resolve(), repository)
            timeout = executor.execute(
                "repo_exec",
                {
                    "argv": [
                        "python3",
                        "-c",
                        "import time; time.sleep(1)",
                    ],
                    "timeout_ms": 10,
                },
            )
            self.assertTrue(timeout.timed_out)
            self.assertIsNone(timeout.exit_code)

    def test_repo_exec_runtime_home_does_not_pollute_candidate_snapshot(self) -> None:
        with TemporaryDirectory() as temporary:
            repository = _repository(Path(temporary).resolve())
            executor = RepositoryToolExecutor(repository)
            executor.execute(
                "repo_edit",
                {"path": "README.md", "old_text": "base\n", "new_text": "candidate\n"},
            )
            result = executor.execute(
                "repo_exec",
                {
                    "argv": [
                        "python3",
                        "-c",
                        "import os; from pathlib import Path; path = Path(os.environ['HOME']) / '.cache' / 'runtime'; path.mkdir(parents=True, exist_ok=True); (path / 'state').write_text('ok', encoding='utf-8')",
                    ],
                },
            )
            self.assertEqual(result.exit_code, 0)
            self.assertFalse((repository / ".cache").exists())
            snapshot = executor.snapshot_evidence()
            self.assertEqual(snapshot.policy_status, "pass")
            self.assertEqual(
                snapshot.files,
                (RuntimeSnapshotFile(path="README.md", status="M"),),
            )

    def test_http_contract_hashes_path_context_and_forbids_docker_controls(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            backend = FakeDockerRuntimeBackend(_repository(root))
            service = _service(backend, root / "journal")
            try:
                with _LiveServer(service) as server:
                    preflight = _write_request(
                        "runtime_preflight",
                        "attempt-1",
                        "operation-preflight",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                    status, headers, _response = server.request(
                        "POST", "/internal/v1/runtime/preflight", preflight
                    )
                    replay_status, replay_headers, _replay = server.request(
                        "POST", "/internal/v1/runtime/preflight", preflight
                    )
                    self.assertEqual((status, replay_status), (200, 200))
                    self.assertEqual(headers["x-repofixlab-idempotent-replay"], "false")
                    self.assertEqual(
                        replay_headers["x-repofixlab-idempotent-replay"], "true"
                    )
                    prepared_body = _write_request(
                        "runtime_prepare_worker",
                        "attempt-1",
                        "operation-prepare",
                        candidate_id=CANDIDATE_ID,
                        instance_id=INSTANCE_ID,
                    )
                    _status, _headers, prepared = server.request(
                        "POST",
                        "/internal/v1/runtime/workers/prepare",
                        prepared_body,
                    )
                    assert isinstance(prepared, Mapping)
                    lease_id = str(prepared["lease_id"])
                    tool_with_context = _write_request(
                        "runtime_execute_tool",
                        "attempt-1",
                        "operation-tool",
                        lease_id=lease_id,
                        tool="repo_list",
                        input={"path": "."},
                    )
                    tool_body = dict(tool_with_context)
                    tool_body.pop("lease_id")
                    tool_status, _tool_headers, tool = server.request(
                        "POST",
                        f"/internal/v1/runtime/workers/{lease_id}/tools",
                        tool_body,
                    )
                    self.assertEqual(tool_status, 200)
                    assert isinstance(tool, Mapping)
                    self.assertEqual(
                        set(tool),
                        {
                            "schema_version",
                            "response_type",
                            "status",
                            "attempt_id",
                            "operation_id",
                            "request_sha256",
                            "lease_id",
                            "tool",
                            "input",
                            "result",
                        },
                    )
                    self.assertEqual(tool["response_type"], "runtime_tool_result")
                    self.assertEqual(tool["lease_id"], lease_id)
                    self.assertEqual(tool["tool"], "repo_list")
                    self.assertEqual(tool["input"], {"path": "."})

                    cross_lease_status, _cross_headers, _cross_response = server.request(
                        "POST",
                        f"/internal/v1/runtime/workers/{'f' * 32}/tools",
                        tool_body,
                    )
                    self.assertEqual(cross_lease_status, 400)

                    invalid = {
                        **preflight,
                        "operation_id": "operation-invalid",
                        "image": "sha256:" + "0" * 64,
                        "command": ["sh"],
                        "mount": "/host",
                        "network": "host",
                        "capability": "SYS_ADMIN",
                        "container_id": "0" * 64,
                    }
                    invalid_status, _invalid_headers, invalid_response = server.request(
                        "POST", "/internal/v1/runtime/preflight", invalid
                    )
                    self.assertEqual(invalid_status, 422)
                    self.assertIn("detail", invalid_response)

                    abort = _write_request(
                        "runtime_abort_attempt",
                        "attempt-1",
                        "operation-abort-http",
                    )
                    mismatch_status, _mismatch_headers, _mismatch = server.request(
                        "POST",
                        "/internal/v1/runtime/attempts/attempt-other/abort",
                        abort,
                    )
                    self.assertEqual(mismatch_status, 400)
                    abort_status, _abort_headers, abort_response = server.request(
                        "POST",
                        "/internal/v1/runtime/attempts/attempt-1/abort",
                        abort,
                    )
                    self.assertEqual(abort_status, 200)
                    self.assertEqual(
                        set(abort_response),
                        {
                            "schema_version",
                            "response_type",
                            "attempt_id",
                            "operation_id",
                            "request_sha256",
                            "status",
                            "cleanup",
                        },
                    )
                    self.assertEqual(abort_response["status"], "aborted")
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
