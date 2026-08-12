# 脚本职责：验证单个受信 Controller 的固定并发容量和容量释放行为。
# 输入边界：使用内存后端、临时日志目录和规范运行时请求。
# 输出边界：断言四个 attempt 并行占用容量且第五个被拒绝。
from __future__ import annotations

from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PACKAGE_ROOT / "controller" / "src"))

from repofixlab_controller.runtime_journal import (  # noqa: E402
    RuntimeOperationJournal,
    runtime_request_sha256,
)
from repofixlab_controller.runtime_service import (  # noqa: E402
    RuntimeCapacityBusy,
    RuntimeCleanupResult,
    RuntimeOperationService,
    RuntimePreflightManifest,
)


CANDIDATE_ID = "task-environment-candidate-v1-axios-5892-test"
INSTANCE_ID = "axios__axios-5892"


def _request(
    request_type: str,
    attempt_id: str,
    operation_id: str,
    **payload: object,
) -> dict[str, object]:
    """函数职责：构造带确定哈希的规范运行时请求。
    输入约束：请求类型、attempt 标识和操作标识均为非空规范文本。
    返回结果：返回含 request_sha256 的请求字典。
    失败语义：输入不可序列化时直接抛出日志规范异常。
    """
    canonical = {
        "schema_version": "v1",
        "request_type": request_type,
        "attempt_id": attempt_id,
        "operation_id": operation_id,
        **payload,
    }
    return {**canonical, "request_sha256": runtime_request_sha256(canonical)}


class _CapacityBackend:
    """类职责：提供不依赖 Git 和 Docker 的容量测试后端。
    持有状态：保存当前活动 attempt 标识集合。
    协作边界：仅实现预检、准备和回收接口。
    """

    def __init__(self) -> None:
        """函数职责：初始化空的活动 attempt 集合。
        输入约束：不接收外部状态。
        返回结果：创建可记录活动 Worker 的后端。
        失败语义：集合分配失败时由解释器抛出异常。
        """
        self.active_attempt_ids: set[str] = set()

    def preflight(
        self, candidate_id: str, instance_id: str
    ) -> RuntimePreflightManifest:
        """函数职责：返回与请求绑定的固定预检清单。
        输入约束：候选标识和实例标识必须匹配测试常量。
        返回结果：返回确定的运行时预检清单。
        失败语义：绑定不一致时抛出断言异常。
        """
        if candidate_id != CANDIDATE_ID or instance_id != INSTANCE_ID:
            raise AssertionError("unexpected task binding")
        return RuntimePreflightManifest(
            manifest_id="runtime-manifest-capacity-test",
            candidate_id=candidate_id,
            instance_id=instance_id,
            policy_sha256="8" * 64,
            task_environment_lock_id="task-environment-lock-capacity-test",
            task_environment_lock_sha256="9" * 64,
            candidate_sha256="7" * 64,
            base_commit="a" * 40,
        )

    def prepare_worker(
        self, attempt_id: str, candidate_id: str, instance_id: str
    ) -> object:
        """函数职责：登记活动 attempt 并返回轻量 Worker 句柄。
        输入约束：任务绑定必须通过预检且 attempt 尚未活动。
        返回结果：返回绑定 attempt 的不可变文本句柄。
        失败语义：重复登记和绑定偏移时抛出断言异常。
        """
        if candidate_id != CANDIDATE_ID or instance_id != INSTANCE_ID:
            raise AssertionError("unexpected task binding")
        if attempt_id in self.active_attempt_ids:
            raise AssertionError("attempt already active")
        self.active_attempt_ids.add(attempt_id)
        return attempt_id

    def recover_attempt(self, attempt_id: str) -> RuntimeCleanupResult:
        """函数职责：回收 attempt 并释放其后端状态。
        输入约束：attempt 标识来自运行时服务。
        返回结果：返回零残留清理证据。
        失败语义：回收幂等且不抛出业务异常。
        """
        self.active_attempt_ids.discard(attempt_id)
        return RuntimeCleanupResult(0, 0)


class RuntimeCapacityTests(unittest.TestCase):
    """类职责：验证固定容量门禁和回收后的容量复用。
    持有状态：每项测试仅持有临时目录和局部服务实例。
    协作边界：不启动 HTTP、Git 和 Docker 资源。
    """

    def test_four_active_attempts_reject_fifth_until_capacity_is_released(
        self,
    ) -> None:
        """函数职责：验证容量四用满后拒绝并在回收后接纳新 attempt。
        输入约束：五个 attempt 使用独立操作标识和相同冻结任务绑定。
        返回结果：四个活动成功、第五个先拒绝后成功。
        失败语义：容量计数偏移时测试失败。
        """
        with TemporaryDirectory() as temporary:
            backend = _CapacityBackend()
            service = RuntimeOperationService(
                backend,
                RuntimeOperationJournal(Path(temporary).resolve()),
                capacity=4,
                id_factory=iter(
                    f"{value:032x}" for value in range(1, 16)
                ).__next__,
            )
            try:
                for number in range(1, 6):
                    attempt_id = f"attempt-{number}"
                    result = service.preflight(
                        _request(
                            "runtime_preflight",
                            attempt_id,
                            f"operation-preflight-{number}",
                            candidate_id=CANDIDATE_ID,
                            instance_id=INSTANCE_ID,
                        )
                    )
                    self.assertEqual(result.response["manifest"]["capacity"], 4)

                for number in range(1, 5):
                    service.prepare_worker(
                        _request(
                            "runtime_prepare_worker",
                            f"attempt-{number}",
                            f"operation-prepare-{number}",
                            candidate_id=CANDIDATE_ID,
                            instance_id=INSTANCE_ID,
                        )
                    )

                fifth_prepare = _request(
                    "runtime_prepare_worker",
                    "attempt-5",
                    "operation-prepare-5",
                    candidate_id=CANDIDATE_ID,
                    instance_id=INSTANCE_ID,
                )
                with self.assertRaises(RuntimeCapacityBusy):
                    service.prepare_worker(fifth_prepare)

                service.abort_attempt(
                    _request(
                        "runtime_abort_attempt",
                        "attempt-1",
                        "operation-abort-1",
                    )
                )
                service.prepare_worker(fifth_prepare)
                self.assertEqual(
                    backend.active_attempt_ids,
                    {"attempt-2", "attempt-3", "attempt-4", "attempt-5"},
                )
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
