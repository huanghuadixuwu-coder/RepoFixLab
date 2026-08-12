# 脚本职责：验证 Controller 应用配置解析和启动证据结构。
# 输入边界：使用受控环境变量和伪 Docker 客户端。
# 输出边界：断言布尔开关、运行时容量和证据校验确定失败。

from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SOURCE_SCHEMA_PATH = (
    PACKAGE_ROOT / "schemas" / "v1" / "controller-bootstrap-health.schema.json"
)
IMAGE_SCHEMA_PATH = PACKAGE_ROOT / "schemas" / "controller-bootstrap-health.schema.json"
os.environ["REPOFIXLAB_SCHEMA_PATH"] = str(
    SOURCE_SCHEMA_PATH if SOURCE_SCHEMA_PATH.is_file() else IMAGE_SCHEMA_PATH
)
sys.path.insert(0, str(PACKAGE_ROOT / "controller" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from repofixlab_controller.app import (  # noqa: E402
    BOOTSTRAP_HEALTH_VALIDATOR,
    _runtime_capacity_from_environment,
    _runtime_enabled_from_environment,
)
from repofixlab_controller.collector import (  # noqa: E402
    collect_bootstrap_health,
    unreachable_bootstrap_health,
)
from test_collector import FakeDockerClient  # noqa: E402


class AppValidatorTests(unittest.TestCase):
    """类职责：验证 Controller 应用配置和证据门禁。
    持有状态：每项测试仅持有局部环境补丁。
    协作边界：不启动真实 HTTP 服务和 Docker 资源。"""

    def test_accepts_complete_runtime_image_provenance(self) -> None:
        payload = collect_bootstrap_health(FakeDockerClient()).to_dict()

        BOOTSTRAP_HEALTH_VALIDATOR.validate(payload)

    def test_accepts_fail_closed_unreachable_image_provenance(self) -> None:
        payload = unreachable_bootstrap_health(RuntimeError("unreachable")).to_dict()

        BOOTSTRAP_HEALTH_VALIDATOR.validate(payload)

    def test_runtime_enablement_is_explicit_and_fail_closed(self) -> None:
        with patch.dict(os.environ, {"REPOFIXLAB_RUNTIME_ENABLED": "false"}):
            self.assertFalse(_runtime_enabled_from_environment())
        with patch.dict(os.environ, {"REPOFIXLAB_RUNTIME_ENABLED": "true"}):
            self.assertTrue(_runtime_enabled_from_environment())
        with patch.dict(os.environ, {"REPOFIXLAB_RUNTIME_ENABLED": "disabled"}):
            with self.assertRaisesRegex(RuntimeError, "must be exactly true or false"):
                _runtime_enabled_from_environment()

    def test_runtime_capacity_is_bounded_and_exact(self) -> None:
        """函数职责：验证运行时容量只接受一到十六的规范整数。
        输入约束：环境补丁覆盖缺省值、边界值和非法文本。
        返回结果：缺省为一，四被接受，非法值被拒绝。
        失败语义：解析结果偏离固定范围时测试失败。"""

        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_runtime_capacity_from_environment(), 1)
        with patch.dict(os.environ, {"REPOFIXLAB_RUNTIME_CAPACITY": "4"}):
            self.assertEqual(_runtime_capacity_from_environment(), 4)
        for value in ("0", "17", "04", "four"):
            with self.subTest(value=value), patch.dict(
                os.environ, {"REPOFIXLAB_RUNTIME_CAPACITY": value}
            ):
                with self.assertRaisesRegex(RuntimeError, "integer from 1 through 16"):
                    _runtime_capacity_from_environment()


if __name__ == "__main__":
    unittest.main()
