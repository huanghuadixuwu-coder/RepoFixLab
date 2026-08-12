# 脚本职责：管理受信运行时操作、并发容量、恢复状态和持久化证据。
# 输入边界：接收契约化请求、Docker 运行时后端和操作日志。
# 输出边界：返回幂等响应并保证每项活跃 attempt 独占一个容量槽。

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
import base64
import hashlib
from pathlib import PurePosixPath
import re
from threading import Event, Lock
from typing import Literal, Protocol
from uuid import uuid4

from .runtime_journal import (
    PersistedRuntimeOperation,
    RuntimeJournalError,
    RuntimeOperationJournal,
    canonical_runtime_bytes,
    runtime_request_sha256,
)
from .runtime_tools import (
    RUNTIME_TOOL_NAMES,
    RuntimeToolError,
    RuntimeToolName,
    RuntimeToolResult,
    RuntimeVerificationCatalog,
    RuntimeVerificationObservation,
    RuntimeVerificationResult,
    RuntimeSnapshotEvidence,
    SNAPSHOT_LIMIT_BYTES,
    tool_rejection_reason_code,
)


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_GIT_OBJECT_ID = re.compile(r"^[a-f0-9]{40}$")
_ARTIFACT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_WRITE_BASE_KEYS = frozenset(
    {"schema_version", "request_type", "attempt_id", "operation_id", "request_sha256"}
)
_ARTIFACT_LIMIT_BYTES = 1024 * 1024
_ARTIFACT_SET_LIMIT_BYTES = 4 * 1024 * 1024


class RuntimeRequestRejected(RuntimeError):
    """A caller request is outside the versioned runtime contract."""


class RuntimeOperationConflict(RuntimeError):
    """An operation ID is already bound to a different canonical request."""


class RuntimeCapacityBusy(RuntimeError):
    """类职责：表达运行时容量已经用尽。
    持有状态：保存稳定错误消息。
    协作边界：不修改 attempt 及容量状态。"""


class RuntimeInvalidState(RuntimeError):
    """A valid request is not allowed in the attempt's current phase."""


class RuntimeResourceNotFound(RuntimeError):
    """A lease, snapshot, job, or attempt is unknown."""


class RuntimeServiceUnavailable(RuntimeError):
    """The runtime cannot safely execute or recover an operation."""


@dataclass(frozen=True)
class RuntimePreflightManifest:
    manifest_id: str
    candidate_id: str
    instance_id: str
    policy_sha256: str
    task_environment_lock_id: str
    task_environment_lock_sha256: str
    candidate_sha256: str
    base_commit: str
    tools: tuple[RuntimeToolName, ...] = RUNTIME_TOOL_NAMES


@dataclass(frozen=True)
class RuntimeCleanupResult:
    residual_container_count: int
    residual_volume_count: int
    errors: tuple[str, ...] = ()

    @property
    def clean(self) -> bool:
        return (
            self.residual_container_count == 0
            and self.residual_volume_count == 0
            and not self.errors
        )

    def public_dict(self) -> dict[str, object]:
        return {
            "residual_container_count": self.residual_container_count,
            "residual_volume_count": self.residual_volume_count,
            "error_count": len(self.errors),
            "clean": self.clean,
        }


@dataclass(frozen=True)
class RuntimeJobStatus:
    status: Literal["queued", "running", "completed", "failed"]
    resolved: bool | None
    error_class: str | None


class RuntimeBackendProtocol(Protocol):
    def preflight(
        self, candidate_id: str, instance_id: str
    ) -> RuntimePreflightManifest: ...

    def prepare_worker(
        self, attempt_id: str, candidate_id: str, instance_id: str
    ) -> object: ...

    def execute_tool(
        self,
        worker: object,
        tool: RuntimeToolName,
        arguments: Mapping[str, object],
    ) -> RuntimeToolResult: ...

    def verification_catalog(self, worker: object) -> RuntimeVerificationCatalog: ...

    def verify_catalog_entry(
        self,
        worker: object,
        catalog: RuntimeVerificationCatalog,
        candidate_id: str,
        patch: bytes,
    ) -> RuntimeVerificationResult: ...

    def snapshot_patch(self, worker: object) -> RuntimeSnapshotEvidence: ...

    def destroy_worker(self, worker: object) -> RuntimeCleanupResult: ...

    def start_evaluation(
        self,
        attempt_id: str,
        run_id: str,
        job_id: str,
        evaluation_id: str,
        candidate_id: str,
        instance_id: str,
        patch: bytes,
    ) -> object: ...

    def get_job(self, job: object) -> RuntimeJobStatus: ...

    def get_artifacts(self, job: object) -> Mapping[str, bytes]: ...

    def acknowledge_artifacts(self, job: object) -> RuntimeCleanupResult: ...

    def recover_attempt(self, attempt_id: str) -> RuntimeCleanupResult: ...


@dataclass(frozen=True)
class RuntimeOperationResult:
    response: dict[str, object]
    replayed: bool


@dataclass
class _OperationState:
    request: dict[str, object]
    request_sha256: str
    event: Event = field(default_factory=Event)
    response: dict[str, object] | None = None
    unavailable: bool = False


@dataclass
class _AttemptState:
    attempt_id: str
    candidate_id: str | None = None
    instance_id: str | None = None
    phase: str = "new"
    capacity_owned: bool = False
    lease_id: str | None = None
    worker: object | None = None
    snapshot_id: str | None = None
    patch: bytes | None = None
    worker_cleanup: RuntimeCleanupResult | None = None
    job_id: str | None = None
    job: object | None = None
    artifact_set_sha256: str | None = None
    artifact_response: dict[str, object] | None = None
    base_commit: str | None = None
    snapshot_policy_passed: bool = False
    run_id: str | None = None
    evaluation_id: str | None = None
    verification_catalog: RuntimeVerificationCatalog | None = None


class RuntimeOperationService:
    """类职责：执行幂等运行时操作并管理固定并发容量。
    持有状态：保存 attempt、作业、容量占用、恢复门禁和操作日志。
    协作边界：通过后端管理工作区，不接触模型凭据。"""

    def __init__(
        self,
        backend: RuntimeBackendProtocol,
        journal: RuntimeOperationJournal,
        *,
        id_factory: Callable[[], str] = lambda: uuid4().hex,
        clock: Callable[[], str] = lambda: datetime.now(UTC).isoformat().replace(
            "+00:00", "Z"
        ),
        capacity: int = 1,
    ) -> None:
        """函数职责：绑定运行时依赖并恢复持久化状态。
        输入约束：容量是一区间内的整数且日志属于当前 Controller。
        返回结果：创建完成恢复且容量计数一致的服务。
        失败语义：容量非法及恢复失败时同步抛出异常。"""
        if (
            isinstance(capacity, bool)
            or not isinstance(capacity, int)
            or not 1 <= capacity <= 16
        ):
            raise ValueError("runtime capacity must be an integer from 1 through 16")
        self._backend = backend
        self._journal = journal
        self._id_factory = id_factory
        self._clock = clock
        self._lock = Lock()
        self._execution_lock = Lock()
        self._operations: dict[str, _OperationState] = {}
        self._attempts: dict[str, _AttemptState] = {}
        self._jobs: dict[str, str] = {}
        self._capacity = capacity
        self._capacity_attempt_ids: set[str] = set()
        self._recovery_blocked = False
        self._recover()

    def close(self) -> None:
        self._journal.close()

    def preflight(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        """函数职责：校验任务绑定并返回当前运行时容量。
        输入约束：请求身份、候选和实例满足冻结契约。
        返回结果：返回基线、镜像、锁和容量证据。
        失败语义：绑定漂移及后端失败时拒绝请求。"""
        canonical = _validate_write_request(
            request,
            "runtime_preflight",
            frozenset({"candidate_id", "instance_id"}),
        )

        def precheck() -> None:
            attempt = self._attempt(canonical)
            if attempt.phase not in {"new", "preflighted"}:
                raise RuntimeInvalidState("attempt is past preflight")
            self._bind_candidate(attempt, canonical)

        def perform() -> dict[str, object]:
            attempt = self._attempt(canonical)
            candidate_id = _request_string(canonical, "candidate_id")
            instance_id = _request_string(canonical, "instance_id")
            manifest = self._backend.preflight(candidate_id, instance_id)
            _validate_manifest(manifest, candidate_id, instance_id)
            attempt.phase = "preflighted"
            attempt.base_commit = manifest.base_commit
            return _write_response(
                canonical,
                "runtime_preflight",
                "ready",
                manifest={
                    "manifest_id": manifest.manifest_id,
                    "candidate_id": manifest.candidate_id,
                    "instance_id": manifest.instance_id,
                    "policy_sha256": manifest.policy_sha256,
                    "task_environment_lock_id": (
                        manifest.task_environment_lock_id
                    ),
                    "task_environment_lock_sha256": (
                        manifest.task_environment_lock_sha256
                    ),
                    "candidate_sha256": manifest.candidate_sha256,
                    "base_commit": manifest.base_commit,
                    "tools": list(manifest.tools),
                    "capacity": self._capacity,
                },
            )

        return self._execute_write(canonical, precheck, perform)

    def prepare_worker(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        """函数职责：在固定容量内准备一个隔离 Worker。
        输入约束：attempt 已完成预检且恢复门禁处于开放状态。
        返回结果：登记容量占用并返回独占租约。
        失败语义：容量用尽、状态失配及后端失败时拒绝请求。"""
        canonical = _validate_write_request(
            request,
            "runtime_prepare_worker",
            frozenset({"candidate_id", "instance_id"}),
        )

        def precheck() -> None:
            if self._recovery_blocked:
                raise RuntimeServiceUnavailable(
                    "runtime recovery left residual resources"
                )
            attempt = self._attempt(canonical)
            self._bind_candidate(attempt, canonical)
            if attempt.phase != "preflighted":
                raise RuntimeInvalidState("worker preparation requires preflight")
            if (
                attempt.attempt_id not in self._capacity_attempt_ids
                and len(self._capacity_attempt_ids) >= self._capacity
            ):
                raise RuntimeCapacityBusy("runtime attempt capacity is busy")

        def perform() -> dict[str, object]:
            attempt = self._attempt(canonical)
            worker = self._backend.prepare_worker(
                attempt.attempt_id,
                _required_attempt_value(attempt.candidate_id, "candidate"),
                _required_attempt_value(attempt.instance_id, "instance"),
            )
            lease_id = f"lease-{self._validated_id_token()}"
            attempt.worker = worker
            attempt.lease_id = lease_id
            attempt.phase = "worker_active"
            attempt.capacity_owned = True
            self._capacity_attempt_ids.add(attempt.attempt_id)
            return _write_response(
                canonical,
                "runtime_worker_prepared",
                "prepared",
                lease_id=lease_id,
            )

        return self._execute_write(canonical, precheck, perform)

    def execute_tool(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        canonical = _validate_write_request(
            request,
            "runtime_execute_tool",
            frozenset({"lease_id", "tool", "input"}),
        )
        tool_value = canonical.get("tool")
        tool_input = canonical.get("input")
        if tool_value not in RUNTIME_TOOL_NAMES or not isinstance(tool_input, dict):
            raise RuntimeRequestRejected("runtime tool request is malformed")
        tool = tool_value

        def precheck() -> None:
            attempt = self._require_worker_attempt(canonical)
            if attempt.phase not in {"worker_active", "snapshotted"}:
                raise RuntimeInvalidState("runtime tool requires an active worker")

        def perform() -> dict[str, object]:
            attempt = self._require_worker_attempt(canonical)
            worker = _required_handle(attempt.worker, "worker")
            result = self._backend.execute_tool(worker, tool, tool_input)
            if result.tool != tool:
                raise RuntimeServiceUnavailable("runtime backend tool identity drifted")
            if tool in {"repo_edit", "repo_exec"}:
                attempt.phase = "worker_active"
                attempt.patch = None
                attempt.snapshot_id = None
                attempt.snapshot_policy_passed = False
            return _write_response(
                canonical,
                "runtime_tool_result",
                "completed",
                lease_id=_request_string(canonical, "lease_id"),
                tool=tool,
                input=dict(tool_input),
                result=result.to_dict(),
            )

        return self._execute_write(canonical, precheck, perform)

    def verification_catalog(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        canonical = _validate_write_request(
            request,
            "runtime_verification_catalog",
            frozenset({"lease_id"}),
        )

        def precheck() -> None:
            attempt = self._require_worker_attempt(canonical)
            if attempt.phase not in {"worker_active", "snapshotted"}:
                raise RuntimeInvalidState("verification catalog requires an active worker")

        def perform() -> dict[str, object]:
            attempt = self._require_worker_attempt(canonical)
            catalog = self._backend.verification_catalog(
                _required_handle(attempt.worker, "worker")
            )
            _validate_verification_catalog(catalog)
            attempt.verification_catalog = catalog
            return _write_response(
                canonical,
                "runtime_verification_catalog",
                "ready",
                lease_id=_request_string(canonical, "lease_id"),
                catalog=catalog.public_dict(),
            )

        return self._execute_write(canonical, precheck, perform)

    def verify_catalog_entry(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        canonical = _validate_write_request(
            request,
            "runtime_verify_catalog",
            frozenset({"lease_id", "catalog_id", "candidate_id"}),
        )

        def precheck() -> None:
            attempt = self._require_worker_attempt(canonical)
            if (
                attempt.phase != "snapshotted"
                or attempt.patch is None
                or attempt.verification_catalog is None
            ):
                raise RuntimeInvalidState(
                    "catalog verification requires a current snapshot and catalog"
                )
            if canonical.get("catalog_id") != attempt.verification_catalog.catalog_id:
                raise RuntimeRequestRejected("verification catalog does not belong to the active worker")

        def perform() -> dict[str, object]:
            attempt = self._require_worker_attempt(canonical)
            catalog = attempt.verification_catalog
            if catalog is None:
                raise RuntimeServiceUnavailable("verification catalog disappeared")
            result = self._backend.verify_catalog_entry(
                _required_handle(attempt.worker, "worker"),
                catalog,
                _request_string(canonical, "candidate_id"),
                _required_patch(attempt.patch),
            )
            _validate_verification_result(
                result,
                catalog.catalog_id,
                _request_string(canonical, "candidate_id"),
            )
            return _write_response(
                canonical,
                "runtime_verification_result",
                "completed",
                lease_id=_request_string(canonical, "lease_id"),
                result=result.to_dict(),
            )

        return self._execute_write(canonical, precheck, perform)

    def snapshot_patch(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        canonical = _validate_write_request(
            request,
            "runtime_snapshot_patch",
            frozenset({"lease_id"}),
        )

        def precheck() -> None:
            attempt = self._require_worker_attempt(canonical)
            if attempt.phase not in {"worker_active", "snapshotted"}:
                raise RuntimeInvalidState("snapshot requires an active worker")

        def perform() -> dict[str, object]:
            attempt = self._require_worker_attempt(canonical)
            snapshot = self._backend.snapshot_patch(
                _required_handle(attempt.worker, "worker")
            )
            _validate_snapshot(
                snapshot,
                _required_attempt_value(attempt.base_commit, "base commit"),
            )
            patch = snapshot.patch
            patch_sha256 = hashlib.sha256(patch).hexdigest()
            snapshot_id = f"snapshot-{patch_sha256}"
            attempt.patch = patch
            attempt.snapshot_id = snapshot_id
            attempt.snapshot_policy_passed = snapshot.policy_status == "pass"
            attempt.phase = "snapshotted"
            return _write_response(
                canonical,
                "runtime_patch_snapshot",
                "snapshotted",
                snapshot_id=snapshot_id,
                patch_sha256=patch_sha256,
                patch_bytes=len(patch),
                patch_base64=base64.b64encode(patch).decode("ascii"),
                empty=len(patch) == 0,
                base_commit=snapshot.base_commit,
                base_tree={"algorithm": "git-sha1", "value": snapshot.base_tree},
                candidate_tree={
                    "algorithm": "git-sha1",
                    "value": snapshot.candidate_tree,
                },
                files=[
                    {"path": file.path, "status": _public_snapshot_status(file.status)}
                    for file in snapshot.files
                ],
                policy={
                    "status": snapshot.policy_status,
                    "violations": list(snapshot.policy_violations),
                },
                created_at=self._clock(),
            )

        return self._execute_write(canonical, precheck, perform)

    def destroy_worker(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        """函数职责：销毁 Worker 并按快照策略更新容量归属。
        输入约束：attempt 持有当前快照和有效 Worker 租约。
        返回结果：返回清理证据并在策略拒绝时释放容量。
        失败语义：清理残留会封闭恢复门禁且保留容量占用。"""
        canonical = _validate_write_request(
            request,
            "runtime_destroy_worker",
            frozenset({"lease_id"}),
        )

        def precheck() -> None:
            attempt = self._require_worker_attempt(canonical)
            if (
                attempt.phase != "snapshotted"
                or attempt.patch is None
                or attempt.snapshot_id is None
            ):
                raise RuntimeInvalidState("worker destroy requires a current snapshot")

        def perform() -> dict[str, object]:
            attempt = self._require_worker_attempt(canonical)
            cleanup = self._backend.destroy_worker(
                _required_handle(attempt.worker, "worker")
            )
            _validate_cleanup(cleanup)
            attempt.worker = None
            attempt.worker_cleanup = cleanup
            if cleanup.clean and attempt.snapshot_policy_passed:
                attempt.phase = "worker_destroyed"
            elif cleanup.clean:
                attempt.phase = "policy_rejected"
                attempt.capacity_owned = False
                self._capacity_attempt_ids.discard(attempt.attempt_id)
            else:
                attempt.phase = "blocked"
                self._recovery_blocked = True
            return _write_response(
                canonical,
                "runtime_worker_destroyed",
                "destroyed" if cleanup.clean else "blocked",
                lease_id=attempt.lease_id,
                cleanup=cleanup.public_dict(),
            )

        return self._execute_write(canonical, precheck, perform)

    def start_evaluation(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        canonical = _validate_write_request(
            request,
            "runtime_start_evaluation",
            frozenset({"snapshot_id", "run_id"}),
        )

        def precheck() -> None:
            attempt = self._attempt(canonical)
            if (
                attempt.phase != "worker_destroyed"
                or attempt.worker_cleanup is None
                or not attempt.worker_cleanup.clean
                or attempt.patch is None
                or not attempt.snapshot_policy_passed
                or canonical.get("snapshot_id") != attempt.snapshot_id
            ):
                raise RuntimeInvalidState(
                    "fresh evaluation requires destroyed worker, zero residuals, and exact snapshot"
                )

        def perform() -> dict[str, object]:
            attempt = self._attempt(canonical)
            run_id = _request_string(canonical, "run_id")
            job_id = f"job-{self._validated_id_token()}"
            evaluation_id = f"evaluation-{self._validated_id_token()}"
            job = self._backend.start_evaluation(
                attempt.attempt_id,
                run_id,
                job_id,
                evaluation_id,
                _required_attempt_value(attempt.candidate_id, "candidate"),
                _required_attempt_value(attempt.instance_id, "instance"),
                _required_patch(attempt.patch),
            )
            attempt.job = job
            attempt.job_id = job_id
            attempt.run_id = run_id
            attempt.evaluation_id = evaluation_id
            attempt.phase = "evaluating"
            self._jobs[job_id] = attempt.attempt_id
            return _write_response(
                canonical,
                "runtime_evaluation_started",
                "started",
                run_id=run_id,
                job_id=job_id,
                evaluation_id=evaluation_id,
                snapshot_id=attempt.snapshot_id,
            )

        return self._execute_write(canonical, precheck, perform)

    def abort_attempt(self, request: Mapping[str, object]) -> RuntimeOperationResult:
        """函数职责：中止 attempt、回收资源并释放对应容量。
        输入约束：attempt 已在当前服务登记。
        返回结果：返回资源残留计数和清理状态。
        失败语义：清理不完整时保留容量并封闭恢复门禁。"""
        canonical = _validate_write_request(
            request,
            "runtime_abort_attempt",
            frozenset(),
        )

        def precheck() -> None:
            attempt_id = _request_string(canonical, "attempt_id")
            if attempt_id not in self._attempts:
                raise RuntimeResourceNotFound("runtime attempt was not found")

        def perform() -> dict[str, object]:
            attempt_id = _request_string(canonical, "attempt_id")
            attempt = self._attempts[attempt_id]
            cleanup = self._backend.recover_attempt(attempt_id)
            _validate_cleanup(cleanup)
            if cleanup.clean:
                if attempt.job_id is not None:
                    self._jobs.pop(attempt.job_id, None)
                attempt.worker = None
                attempt.job = None
                attempt.lease_id = None
                attempt.job_id = None
                attempt.run_id = None
                attempt.evaluation_id = None
                attempt.patch = None
                attempt.snapshot_id = None
                attempt.snapshot_policy_passed = False
                attempt.worker_cleanup = cleanup
                attempt.artifact_response = None
                attempt.artifact_set_sha256 = None
                attempt.capacity_owned = False
                attempt.phase = "aborted"
                self._capacity_attempt_ids.discard(attempt_id)
                self._recovery_blocked = any(
                    item.phase == "blocked"
                    for other_id, item in self._attempts.items()
                    if other_id != attempt_id
                )
            else:
                attempt.phase = "blocked"
                attempt.capacity_owned = True
                self._recovery_blocked = True
            return _write_response(
                canonical,
                "runtime_attempt_aborted",
                "aborted" if cleanup.clean else "blocked",
                cleanup=cleanup.public_dict(),
            )

        return self._execute_write(canonical, precheck, perform)

    def get_job(self, job_id: str) -> dict[str, object]:
        attempt = self._job_attempt(job_id)
        status = self._backend.get_job(_required_handle(attempt.job, "evaluation job"))
        if status.status not in {"queued", "running", "completed", "failed"}:
            raise RuntimeServiceUnavailable("runtime backend job status drifted")
        return {
            "schema_version": "v1",
            "response_type": "runtime_job_status",
            "attempt_id": attempt.attempt_id,
            "run_id": attempt.run_id,
            "job_id": job_id,
            "evaluation_id": attempt.evaluation_id,
            "status": status.status,
            "resolved": status.resolved,
            "error_class": status.error_class,
        }

    def get_artifacts(self, job_id: str) -> dict[str, object]:
        attempt = self._job_attempt(job_id)
        status = self._backend.get_job(_required_handle(attempt.job, "evaluation job"))
        if status.status not in {"completed", "failed"}:
            raise RuntimeInvalidState("job artifacts are not terminal")
        if attempt.artifact_response is None:
            artifacts = self._backend.get_artifacts(
                _required_handle(attempt.job, "evaluation job")
            )
            response = _artifact_response(attempt.attempt_id, job_id, artifacts)
            attempt.artifact_response = response
            attempt.artifact_set_sha256 = str(response["artifact_set_sha256"])
        return dict(attempt.artifact_response)

    def acknowledge_artifacts(
        self, request: Mapping[str, object]
    ) -> RuntimeOperationResult:
        """函数职责：确认评估产物并释放作业容量。
        输入约束：作业已终态且产物集合哈希完全匹配。
        返回结果：返回评估清理证据和确认状态。
        失败语义：清理不完整时封闭恢复门禁且不释放容量。"""
        canonical = _validate_write_request(
            request,
            "runtime_ack_artifacts",
            frozenset({"job_id", "artifact_set_sha256"}),
        )

        def precheck() -> None:
            job_id = _request_string(canonical, "job_id")
            attempt = self._job_attempt(job_id)
            if attempt.attempt_id != canonical["attempt_id"]:
                raise RuntimeResourceNotFound("job does not belong to the attempt")
            if attempt.phase != "evaluating":
                raise RuntimeInvalidState("artifact acknowledgement requires evaluation")
            if attempt.artifact_response is None:
                self.get_artifacts(job_id)
            if canonical.get("artifact_set_sha256") != attempt.artifact_set_sha256:
                raise RuntimeRequestRejected("artifact set SHA-256 does not match")

        def perform() -> dict[str, object]:
            attempt = self._job_attempt(_request_string(canonical, "job_id"))
            cleanup = self._backend.acknowledge_artifacts(
                _required_handle(attempt.job, "evaluation job")
            )
            _validate_cleanup(cleanup)
            attempt.job = None
            attempt.phase = "acked" if cleanup.clean else "blocked"
            attempt.capacity_owned = False
            if cleanup.clean:
                self._capacity_attempt_ids.discard(attempt.attempt_id)
            else:
                self._recovery_blocked = True
            return _write_response(
                canonical,
                "runtime_artifacts_acknowledged",
                "acknowledged" if cleanup.clean else "blocked",
                job_id=attempt.job_id,
                artifact_set_sha256=attempt.artifact_set_sha256,
                cleanup=cleanup.public_dict(),
            )

        return self._execute_write(canonical, precheck, perform)

    def _execute_write(
        self,
        request: dict[str, object],
        precheck: Callable[[], None],
        perform: Callable[[], dict[str, object]],
    ) -> RuntimeOperationResult:
        operation_id = _request_string(request, "operation_id")
        request_hash = _request_string(request, "request_sha256")
        wait_for: Event | None = None
        state: _OperationState | None = None
        with self._lock:
            existing = self._operations.get(operation_id)
            if existing is not None:
                if (
                    existing.request_sha256 != request_hash
                    or existing.request != request
                ):
                    raise RuntimeOperationConflict(
                        "operation_id conflicts with an existing request"
                    )
                if existing.response is not None:
                    return self._replayed_result(existing.response)
                if existing.unavailable:
                    raise RuntimeServiceUnavailable(
                        "runtime operation has no recoverable response"
                    )
                wait_for = existing.event
            else:
                state = _OperationState(dict(request), request_hash)
                self._operations[operation_id] = state
        if wait_for is not None:
            wait_for.wait()
            with self._lock:
                existing = self._operations[operation_id]
                if existing.response is not None:
                    return self._replayed_result(existing.response)
                raise RuntimeServiceUnavailable(
                    "runtime operation has no recoverable response"
                )

        assert state is not None
        with self._execution_lock:
            try:
                precheck()
            except Exception:
                with self._lock:
                    self._operations.pop(operation_id, None)
                state.event.set()
                raise
            body = dict(request)
            body.pop("request_sha256")
            try:
                self._journal.begin(body, request_hash)
                try:
                    response = perform()
                except RuntimeToolError as error:
                    response = _write_response(
                        request,
                        "runtime_operation_rejected",
                        "rejected",
                        error_class="tool_request_rejected",
                        reason_code=tool_rejection_reason_code(error),
                    )
                    self._journal.finish(body, request_hash, response)
                    with self._lock:
                        state.response = response
                    raise RuntimeRequestRejected("runtime tool request was rejected")
                except Exception:
                    response = _write_response(
                        request,
                        "runtime_operation_failed",
                        "failed",
                        error_class="runtime_backend_error",
                    )
                    self._journal.finish(
                        body,
                        request_hash,
                        response,
                        event="recovered_interrupted",
                    )
                    with self._lock:
                        state.response = response
                    raise RuntimeServiceUnavailable(
                        "runtime backend operation failed"
                    ) from None
                self._journal.finish(body, request_hash, response)
                with self._lock:
                    state.response = response
                return RuntimeOperationResult(dict(response), False)
            except (RuntimeRequestRejected, RuntimeServiceUnavailable):
                raise
            except Exception:
                with self._lock:
                    state.unavailable = True
                raise RuntimeServiceUnavailable(
                    "runtime operation could not persist a terminal response"
                ) from None
            finally:
                state.event.set()

    def _replayed_result(self, response: Mapping[str, object]) -> RuntimeOperationResult:
        if response.get("status") == "rejected":
            raise RuntimeRequestRejected("runtime tool request was rejected")
        if response.get("status") == "failed":
            raise RuntimeServiceUnavailable("runtime backend operation failed")
        return RuntimeOperationResult(dict(response), True)

    def _attempt(self, request: Mapping[str, object]) -> _AttemptState:
        attempt_id = _request_string(request, "attempt_id")
        return self._attempts.setdefault(attempt_id, _AttemptState(attempt_id))

    def _bind_candidate(
        self, attempt: _AttemptState, request: Mapping[str, object]
    ) -> None:
        candidate_id = _request_string(request, "candidate_id")
        instance_id = _request_string(request, "instance_id")
        if attempt.candidate_id is None:
            attempt.candidate_id = candidate_id
            attempt.instance_id = instance_id
        elif (
            attempt.candidate_id != candidate_id
            or attempt.instance_id != instance_id
        ):
            raise RuntimeOperationConflict(
                "attempt_id conflicts with an existing candidate binding"
            )

    def _require_worker_attempt(
        self, request: Mapping[str, object]
    ) -> _AttemptState:
        attempt = self._attempt(request)
        lease_id = request.get("lease_id")
        if not isinstance(lease_id, str) or lease_id != attempt.lease_id:
            raise RuntimeResourceNotFound("worker lease was not found")
        return attempt

    def _job_attempt(self, job_id: str) -> _AttemptState:
        if not isinstance(job_id, str) or _IDENTIFIER.fullmatch(job_id) is None:
            raise RuntimeResourceNotFound("job was not found")
        attempt_id = self._jobs.get(job_id)
        if attempt_id is None:
            raise RuntimeResourceNotFound("job was not found")
        attempt = self._attempts[attempt_id]
        if attempt.job_id != job_id or attempt.job is None:
            raise RuntimeInvalidState("job is no longer active")
        return attempt

    def _validated_id_token(self) -> str:
        value = self._id_factory()
        if not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{32}", value) is None:
            raise RuntimeServiceUnavailable("runtime ID factory returned an invalid token")
        return value

    def _recover(self) -> None:
        """函数职责：恢复日志并清理重启前的全部活跃 attempt。
        输入约束：日志记录属于当前 Controller 工作卷。
        返回结果：重建幂等响应且清空已回收容量。
        失败语义：任一恢复清理失败时服务启动失败。"""
        try:
            persisted = self._journal.load()
            pending: list[PersistedRuntimeOperation] = []
            for operation in persisted:
                operation_id = _request_string(operation.request, "operation_id")
                state = _OperationState(
                    request={**dict(operation.request), "request_sha256": operation.request_sha256},
                    request_sha256=operation.request_sha256,
                    response=(
                        dict(operation.response)
                        if operation.response is not None
                        else None
                    ),
                )
                if state.response is not None:
                    state.event.set()
                    self._restore_response(state.response)
                else:
                    pending.append(operation)
                self._operations[operation_id] = state
            active_attempts = {
                attempt.attempt_id
                for attempt in self._attempts.values()
                if attempt.phase
                in {
                    "worker_active",
                    "snapshotted",
                    "worker_destroyed",
                    "evaluating",
                }
            }
            active_attempts.update(
                _request_string(operation.request, "attempt_id")
                for operation in pending
            )
            for attempt_id in sorted(active_attempts):
                cleanup = self._backend.recover_attempt(attempt_id)
                _validate_cleanup(cleanup)
                recovered_pending = False
                for operation in pending:
                    if _request_string(operation.request, "attempt_id") != attempt_id:
                        continue
                    recovered_pending = True
                    response = _recovery_response(
                        operation.request,
                        operation.request_sha256,
                        cleanup,
                    )
                    self._journal.finish(
                        operation.request,
                        operation.request_sha256,
                        response,
                        event="recovered_interrupted",
                    )
                    operation_id = _request_string(operation.request, "operation_id")
                    state = self._operations[operation_id]
                    state.response = response
                    state.event.set()
                if not recovered_pending:
                    recovery_body: dict[str, object] = {
                        "schema_version": "v1",
                        "request_type": "runtime_recovery",
                        "attempt_id": attempt_id,
                        "operation_id": (
                            "recovery:"
                            + hashlib.sha256(attempt_id.encode("utf-8")).hexdigest()[:32]
                        ),
                        "reason": "controller_restart",
                    }
                    recovery_hash = runtime_request_sha256(recovery_body)
                    recovery_response = _recovery_response(
                        recovery_body,
                        recovery_hash,
                        cleanup,
                        response_type="runtime_recovery",
                    )
                    self._journal.begin(recovery_body, recovery_hash)
                    self._journal.finish(
                        recovery_body,
                        recovery_hash,
                        recovery_response,
                        event="recovered_interrupted",
                    )
                    recovery_operation_id = _request_string(
                        recovery_body, "operation_id"
                    )
                    recovery_state = _OperationState(
                        request={
                            **recovery_body,
                            "request_sha256": recovery_hash,
                        },
                        request_sha256=recovery_hash,
                        response=recovery_response,
                    )
                    recovery_state.event.set()
                    self._operations[recovery_operation_id] = recovery_state
                attempt = self._attempts.setdefault(attempt_id, _AttemptState(attempt_id))
                attempt.phase = "recovered" if cleanup.clean else "blocked"
                attempt.capacity_owned = False
                if not cleanup.clean:
                    self._recovery_blocked = True
            self._capacity_attempt_ids.clear()
        except Exception as error:
            raise RuntimeServiceUnavailable("runtime recovery failed") from error

    def _restore_response(self, response: Mapping[str, object]) -> None:
        attempt_id = _request_string(response, "attempt_id")
        attempt = self._attempts.setdefault(attempt_id, _AttemptState(attempt_id))
        response_type = response.get("response_type")
        if response_type == "runtime_preflight":
            manifest = response.get("manifest")
            if not isinstance(manifest, Mapping):
                raise RuntimeJournalError("persisted runtime manifest is malformed")
            attempt.candidate_id = _request_string(manifest, "candidate_id")
            attempt.instance_id = _request_string(manifest, "instance_id")
            attempt.base_commit = _request_string(manifest, "base_commit")
            attempt.phase = "preflighted"
        elif response_type == "runtime_worker_prepared":
            attempt.lease_id = _request_string(response, "lease_id")
            attempt.phase = "worker_active"
            attempt.capacity_owned = True
        elif response_type == "runtime_patch_snapshot":
            attempt.snapshot_id = _request_string(response, "snapshot_id")
            policy = response.get("policy")
            attempt.snapshot_policy_passed = (
                isinstance(policy, Mapping) and policy.get("status") == "pass"
            )
            attempt.phase = "snapshotted"
            attempt.capacity_owned = True
        elif response_type == "runtime_worker_destroyed":
            if response.get("status") != "destroyed":
                attempt.phase = "blocked"
                attempt.capacity_owned = True
            elif attempt.snapshot_policy_passed:
                attempt.phase = "worker_destroyed"
                attempt.capacity_owned = True
            else:
                attempt.phase = "policy_rejected"
                attempt.capacity_owned = False
            if attempt.phase == "blocked":
                self._recovery_blocked = True
        elif response_type == "runtime_evaluation_started":
            attempt.job_id = _request_string(response, "job_id")
            attempt.run_id = _request_string(response, "run_id")
            attempt.evaluation_id = _request_string(response, "evaluation_id")
            attempt.phase = "evaluating"
            attempt.capacity_owned = True
            self._jobs[attempt.job_id] = attempt_id
        elif response_type == "runtime_artifacts_acknowledged":
            attempt.phase = "acked" if response.get("status") == "acknowledged" else "blocked"
            attempt.capacity_owned = False
            if attempt.phase == "blocked":
                self._recovery_blocked = True
        elif response_type == "runtime_attempt_aborted":
            attempt.phase = "aborted" if response.get("status") == "aborted" else "blocked"
            attempt.capacity_owned = attempt.phase == "blocked"
            if attempt.phase == "blocked":
                self._recovery_blocked = True
        elif response_type in {"runtime_operation_failed", "runtime_operation_rejected"}:
            pass
        elif response_type == "runtime_recovery":
            attempt.phase = (
                "recovered" if response.get("status") == "recovered" else "blocked"
            )
            if attempt.phase == "blocked":
                self._recovery_blocked = True


def _validate_write_request(
    request: Mapping[str, object],
    request_type: str,
    payload_keys: frozenset[str],
) -> dict[str, object]:
    if not isinstance(request, Mapping) or set(request) != _WRITE_BASE_KEYS | payload_keys:
        raise RuntimeRequestRejected("runtime request envelope is not exact")
    attempt_id = request.get("attempt_id")
    operation_id = request.get("operation_id")
    supplied_hash = request.get("request_sha256")
    if (
        request.get("schema_version") != "v1"
        or request.get("request_type") != request_type
        or not isinstance(attempt_id, str)
        or _IDENTIFIER.fullmatch(attempt_id) is None
        or not isinstance(operation_id, str)
        or _IDENTIFIER.fullmatch(operation_id) is None
        or not isinstance(supplied_hash, str)
        or _SHA256.fullmatch(supplied_hash) is None
    ):
        raise RuntimeRequestRejected("runtime request identity is malformed")
    canonical = dict(request)
    canonical.pop("request_sha256")
    if runtime_request_sha256(canonical) != supplied_hash:
        raise RuntimeRequestRejected("runtime request SHA-256 does not match")
    return dict(request)


def _write_response(
    request: Mapping[str, object],
    response_type: str,
    status: str,
    **fields: object,
) -> dict[str, object]:
    return {
        "schema_version": "v1",
        "response_type": response_type,
        "attempt_id": _request_string(request, "attempt_id"),
        "operation_id": _request_string(request, "operation_id"),
        "request_sha256": _request_string(request, "request_sha256"),
        "status": status,
        **fields,
    }


def _recovery_response(
    request: Mapping[str, object],
    request_sha256: str,
    cleanup: RuntimeCleanupResult,
    *,
    response_type: str = "runtime_operation_failed",
) -> dict[str, object]:
    return {
        "schema_version": "v1",
        "response_type": response_type,
        "attempt_id": _request_string(request, "attempt_id"),
        "operation_id": _request_string(request, "operation_id"),
        "request_sha256": request_sha256,
        "status": (
            "failed"
            if response_type == "runtime_operation_failed"
            else ("recovered" if cleanup.clean else "blocked")
        ),
        "error_class": (
            "controller_restarted"
            if response_type == "runtime_operation_failed"
            else None
        ),
        "cleanup": cleanup.public_dict(),
    }


def _request_string(value: Mapping[str, object], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or not item:
        raise RuntimeRequestRejected(f"runtime field {name} is malformed")
    return item


def _required_attempt_value(value: str | None, description: str) -> str:
    if value is None:
        raise RuntimeInvalidState(f"attempt {description} binding is unavailable")
    return value


def _required_handle(value: object | None, description: str) -> object:
    if value is None:
        raise RuntimeInvalidState(f"runtime {description} handle is unavailable")
    return value


def _required_patch(value: bytes | None) -> bytes:
    if value is None:
        raise RuntimeInvalidState("runtime patch bytes are unavailable")
    return value


def _validate_manifest(
    manifest: RuntimePreflightManifest,
    candidate_id: str,
    instance_id: str,
) -> None:
    if (
        not isinstance(manifest, RuntimePreflightManifest)
        or not manifest.manifest_id
        or manifest.candidate_id != candidate_id
        or manifest.instance_id != instance_id
        or _SHA256.fullmatch(manifest.policy_sha256) is None
        or _IDENTIFIER.fullmatch(manifest.task_environment_lock_id) is None
        or _SHA256.fullmatch(manifest.task_environment_lock_sha256) is None
        or _SHA256.fullmatch(manifest.candidate_sha256) is None
        or _GIT_OBJECT_ID.fullmatch(manifest.base_commit) is None
        or manifest.tools != RUNTIME_TOOL_NAMES
    ):
        raise RuntimeServiceUnavailable("runtime preflight manifest drifted")


def _validate_verification_catalog(catalog: RuntimeVerificationCatalog) -> None:
    if (
        not isinstance(catalog, RuntimeVerificationCatalog)
        or _IDENTIFIER.fullmatch(catalog.catalog_id) is None
        or _SHA256.fullmatch(catalog.source_sha256) is None
        or not isinstance(catalog.entries, tuple)
        or len(catalog.entries) > 16
    ):
        raise RuntimeServiceUnavailable("runtime verification catalog drifted")
    candidate_ids: set[str] = set()
    for entry in catalog.entries:
        if (
            _IDENTIFIER.fullmatch(entry.candidate_id) is None
            or not entry.description
            or len(entry.description) > 512
            or entry.candidate_id in candidate_ids
        ):
            raise RuntimeServiceUnavailable("runtime verification catalog entry drifted")
        candidate_ids.add(entry.candidate_id)


def _validate_verification_result(
    result: RuntimeVerificationResult,
    expected_catalog_id: str,
    expected_candidate_id: str,
) -> None:
    if (
        not isinstance(result, RuntimeVerificationResult)
        or result.catalog_id != expected_catalog_id
        or result.candidate_id != expected_candidate_id
        or result.status
        not in {
            "passed",
            "test_failed",
            "command_invalid",
            "environment_failure",
            "timed_out",
        }
        or (result.reason_code is not None and not result.reason_code)
        or (result.safe_hint is not None and not result.safe_hint)
        or (
            result.exit_code is not None
            and (isinstance(result.exit_code, bool) or not isinstance(result.exit_code, int))
        )
        or not isinstance(result.stdout, str)
        or not isinstance(result.stderr, str)
        or not isinstance(result.truncated, bool)
        or not isinstance(result.timed_out, bool)
        or isinstance(result.duration_ms, bool)
        or not isinstance(result.duration_ms, int)
        or result.duration_ms < 0
        or not _valid_verification_observation(result.baseline)
    ):
        raise RuntimeServiceUnavailable("runtime verification result drifted")


def _valid_verification_observation(value: object) -> bool:
    if not isinstance(value, RuntimeVerificationObservation):
        return False
    return (
        value.status
        in {
            "passed",
            "test_failed",
            "command_invalid",
            "environment_failure",
            "timed_out",
        }
        and (value.reason_code is None or bool(value.reason_code))
        and (value.safe_hint is None or bool(value.safe_hint))
        and (
            value.exit_code is None
            or (not isinstance(value.exit_code, bool) and isinstance(value.exit_code, int))
        )
        and isinstance(value.stdout, str)
        and isinstance(value.stderr, str)
        and isinstance(value.truncated, bool)
        and isinstance(value.timed_out, bool)
        and not isinstance(value.duration_ms, bool)
        and isinstance(value.duration_ms, int)
        and value.duration_ms >= 0
    )


def _validate_snapshot(
    snapshot: RuntimeSnapshotEvidence,
    expected_base_commit: str,
) -> None:
    if (
        not isinstance(snapshot, RuntimeSnapshotEvidence)
        or not isinstance(snapshot.patch, bytes)
        or len(snapshot.patch) > SNAPSHOT_LIMIT_BYTES
        or snapshot.base_commit != expected_base_commit
        or _GIT_OBJECT_ID.fullmatch(snapshot.base_commit) is None
        or _GIT_OBJECT_ID.fullmatch(snapshot.base_tree) is None
        or _GIT_OBJECT_ID.fullmatch(snapshot.candidate_tree) is None
        or not isinstance(snapshot.files, tuple)
        or not isinstance(snapshot.policy_violations, tuple)
    ):
        raise RuntimeServiceUnavailable("runtime snapshot evidence drifted")
    expected_violations: set[str] = set()
    if len(snapshot.files) > 100:
        expected_violations.add("changed_file_count_exceeded")
    for file in snapshot.files:
        path = PurePosixPath(file.path)
        if (
            not file.path
            or "\\" in file.path
            or path.is_absolute()
            or path.as_posix() != file.path
            or any(part in {"", ".", "..", ".git"} for part in path.parts)
            or len(file.path.encode("utf-8")) > 512
        ):
            expected_violations.add("changed_path_invalid")
        if file.status not in {"A", "D", "M", "T"}:
            expected_violations.add("changed_status_invalid")
    if tuple(sorted(expected_violations)) != snapshot.policy_violations:
        raise RuntimeServiceUnavailable("runtime snapshot policy evidence drifted")


def _public_snapshot_status(status: str) -> str:
    if status == "A":
        return "added"
    if status == "D":
        return "deleted"
    return "modified"


def _validate_cleanup(cleanup: RuntimeCleanupResult) -> None:
    if (
        not isinstance(cleanup, RuntimeCleanupResult)
        or isinstance(cleanup.residual_container_count, bool)
        or cleanup.residual_container_count < 0
        or isinstance(cleanup.residual_volume_count, bool)
        or cleanup.residual_volume_count < 0
        or any(not isinstance(error, str) or not error for error in cleanup.errors)
    ):
        raise RuntimeServiceUnavailable("runtime cleanup evidence is malformed")


def _artifact_response(
    attempt_id: str,
    job_id: str,
    artifacts: Mapping[str, bytes],
) -> dict[str, object]:
    if not artifacts:
        raise RuntimeServiceUnavailable("runtime artifact set is empty")
    total_size = 0
    items: list[dict[str, object]] = []
    for name, content in sorted(artifacts.items()):
        if (
            not isinstance(name, str)
            or _ARTIFACT_NAME.fullmatch(name) is None
            or PurePosixPath(name).name != name
            or not isinstance(content, bytes)
            or len(content) > _ARTIFACT_LIMIT_BYTES
        ):
            raise RuntimeServiceUnavailable("runtime artifact is outside policy")
        total_size += len(content)
        items.append(
            {
                "name": name,
                "sha256": hashlib.sha256(content).hexdigest(),
                "size_bytes": len(content),
                "content_base64": base64.b64encode(content).decode("ascii"),
            }
        )
    if total_size > _ARTIFACT_SET_LIMIT_BYTES:
        raise RuntimeServiceUnavailable("runtime artifact set exceeds policy")
    identity = [
        {name: item[name] for name in ("name", "sha256", "size_bytes")}
        for item in items
    ]
    artifact_set_sha256 = hashlib.sha256(canonical_runtime_bytes(identity)).hexdigest()
    return {
        "schema_version": "v1",
        "response_type": "runtime_job_artifacts",
        "attempt_id": attempt_id,
        "job_id": job_id,
        "status": "ready",
        "artifact_set_sha256": artifact_set_sha256,
        "artifacts": items,
    }
