from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from repofix_dataset_preparer.canonical import canonical_json, sha256_bytes
from repofix_dataset_preparer.constants import (
    DATASET_NAME,
    DATASET_REVISION,
    DATASET_SOURCE_BYTES,
    DATASET_SOURCE_SHA256,
    EXPECTED_RECORD_COUNT,
    EXPECTED_SOURCE_RECORD_COUNT,
    REQUIRED_INSTANCE_ID,
)
from repofix_dataset_preparer import self_check


_IMAGE_ID = "sha256:" + "a" * 64


class SelfCheckTest(unittest.TestCase):
    def _report(
        self,
        *,
        image_id: str = _IMAGE_ID,
        uid: int = 65532,
        gid: int = 65532,
        pyarrow_version: str | None = "25.0.0",
        directories: dict[str, bool] | None = None,
        socket_paths: tuple[str, ...] = (),
        extra_environment: dict[str, str] | None = None,
    ) -> dict[str, object]:
        environment = {"REPOFIX_PREPARER_IMAGE_ID": image_id}
        environment.update(extra_environment or {})
        directory_status = directories or {
            "public": True,
            "control": True,
            "private": True,
        }

        def runtime_id(name: str) -> int:
            return uid if name == "getuid" else gid

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(self_check, "_runtime_id", side_effect=runtime_id),
            patch.object(self_check, "_pyarrow_version", return_value=pyarrow_version),
            patch.object(
                self_check,
                "_data_directories_exist",
                return_value=directory_status,
            ),
            patch.object(
                self_check,
                "_docker_socket_paths_present",
                return_value=socket_paths,
            ),
        ):
            return self_check.build_self_check_report()

    def test_pass_report_records_frozen_runtime_contract_and_self_hash(self) -> None:
        report = self._report()

        self.assertEqual(
            tuple(str(path) for path in self_check.DOCKER_SOCKET_PATHS),
            ("/var/run/docker.sock", "/run/docker.sock"),
        )
        self.assertEqual(
            self_check.SENSITIVE_ENVIRONMENT_NAMES,
            (
                "ZHIPU_API_KEY",
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "DOCKER_HOST",
            ),
        )
        self.assertEqual(report["schema_version"], "v1")
        self.assertEqual(report["report_type"], "dataset_preparer_self_check")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["image_id"], _IMAGE_ID)
        self.assertEqual(
            report["dataset"],
            {
                "name": DATASET_NAME,
                "revision": DATASET_REVISION,
                "source_sha256": DATASET_SOURCE_SHA256,
                "source_bytes": DATASET_SOURCE_BYTES,
                "expected_source_record_count": EXPECTED_SOURCE_RECORD_COUNT,
                "expected_record_count": EXPECTED_RECORD_COUNT,
                "required_instance_id": REQUIRED_INSTANCE_ID,
            },
        )
        self.assertEqual(
            report["runtime"],
            {
                "python_version": "3.11.14",
                "pyarrow_version": "25.0.0",
                "uid": 65532,
                "gid": 65532,
            },
        )
        self.assertEqual(report["errors"], [])
        without_hash = dict(report)
        report_sha256 = without_hash.pop("report_sha256")
        self.assertEqual(report_sha256, sha256_bytes(canonical_json(without_hash)))

    def test_bad_runtime_facts_fail_closed(self) -> None:
        cases = (
            ("uid", {"uid": 0}, "runtime_user"),
            ("gid", {"gid": 0}, "runtime_user"),
            ("pyarrow", {"pyarrow_version": "24.0.0"}, "pyarrow_version"),
            ("image_id", {"image_id": "sha256:not-an-id"}, "image_id_bound"),
            (
                "socket",
                {"socket_paths": ("/var/run/docker.sock",)},
                "docker_socket_absent",
            ),
        )
        for name, overrides, failed_check in cases:
            with self.subTest(name=name):
                report = self._report(**overrides)
                checks = report["checks"]
                assert isinstance(checks, dict)
                self.assertEqual(report["status"], "fail")
                self.assertFalse(checks[failed_check])
                self.assertTrue(report["errors"])

    def test_sensitive_environment_name_fails_without_leaking_its_value(self) -> None:
        secret = "must-not-appear-in-report"

        report = self._report(
            extra_environment={"OPENAI_API_KEY": secret},
        )

        self.assertEqual(report["status"], "fail")
        checks = report["checks"]
        observations = report["observations"]
        assert isinstance(checks, dict)
        assert isinstance(observations, dict)
        self.assertFalse(checks["sensitive_environment_absent"])
        self.assertEqual(
            observations["sensitive_environment_names_present"],
            ["OPENAI_API_KEY"],
        )
        self.assertNotIn(secret, canonical_json(report).decode("utf-8"))

    def test_missing_data_directory_fails_closed(self) -> None:
        report = self._report(
            directories={"public": True, "control": False, "private": True}
        )

        self.assertEqual(report["status"], "fail")
        checks = report["checks"]
        assert isinstance(checks, dict)
        directories = checks["data_directories_exist"]
        assert isinstance(directories, dict)
        self.assertFalse(directories["control"])


if __name__ == "__main__":
    unittest.main()
