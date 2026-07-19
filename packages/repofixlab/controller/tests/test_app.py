from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest


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

from repofixlab_controller.app import BOOTSTRAP_HEALTH_VALIDATOR  # noqa: E402
from repofixlab_controller.collector import (  # noqa: E402
    collect_bootstrap_health,
    unreachable_bootstrap_health,
)
from test_collector import FakeDockerClient  # noqa: E402


class AppValidatorTests(unittest.TestCase):
    def test_accepts_complete_runtime_image_provenance(self) -> None:
        payload = collect_bootstrap_health(FakeDockerClient()).to_dict()

        BOOTSTRAP_HEALTH_VALIDATOR.validate(payload)

    def test_accepts_fail_closed_unreachable_image_provenance(self) -> None:
        payload = unreachable_bootstrap_health(RuntimeError("unreachable")).to_dict()

        BOOTSTRAP_HEALTH_VALIDATOR.validate(payload)


if __name__ == "__main__":
    unittest.main()
