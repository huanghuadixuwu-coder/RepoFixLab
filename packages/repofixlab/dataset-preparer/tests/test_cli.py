from __future__ import annotations

from contextlib import redirect_stderr
import io
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from repofix_dataset_preparer import cli
from repofix_dataset_preparer.constants import (
    DATASET_NAME,
    DATASET_REVISION,
    DATASET_SOURCE_PATH,
    DATASET_SOURCE_SHA256,
)


_IMAGE_ID = "sha256:" + "a" * 64


class _BinaryStdout:
    def __init__(self) -> None:
        self.buffer = io.BytesIO()


class CliTest(unittest.TestCase):
    def _prepare_arguments(self) -> list[str]:
        return [
            "prepare",
            "--source-url",
            (
                f"https://huggingface.co/datasets/{DATASET_NAME}/resolve/"
                f"{DATASET_REVISION}/{DATASET_SOURCE_PATH}"
            ),
            "--source-sha256",
            DATASET_SOURCE_SHA256,
            "--generation-id",
            "generation-1",
            "--public-volume",
            "dataset-public-generation-1",
            "--control-volume",
            "dataset-control-generation-1",
            "--private-volume",
            "dataset-private-generation-1",
        ]

    def test_self_check_never_calls_source_loaders_or_generation_writer(self) -> None:
        output = _BinaryStdout()
        report = {
            "schema_version": "v1",
            "report_type": "dataset_preparer_self_check",
            "status": "pass",
            "report_sha256": "a" * 64,
        }
        with (
            patch.object(cli.sys, "stdout", output),
            patch.object(cli, "build_self_check_report", return_value=report),
            patch.object(cli, "load_file", side_effect=AssertionError("load_file called")),
            patch.object(cli, "load_url", side_effect=AssertionError("load_url called")),
            patch.object(
                cli,
                "prepare_generation",
                side_effect=AssertionError("prepare_generation called"),
            ),
        ):
            exit_code = cli.main(["self-check"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(output.buffer.getvalue()), report)

    def test_self_check_returns_one_for_a_fail_report(self) -> None:
        output = _BinaryStdout()
        report = {
            "schema_version": "v1",
            "report_type": "dataset_preparer_self_check",
            "status": "fail",
            "errors": ["injected failure"],
            "report_sha256": "a" * 64,
        }
        with (
            patch.object(cli.sys, "stdout", output),
            patch.object(cli, "build_self_check_report", return_value=report),
        ):
            exit_code = cli.main(["self-check"])

        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(output.buffer.getvalue()), report)

    def test_self_check_rejects_prepare_only_arguments_before_execution(self) -> None:
        for arguments in (
            ["self-check", "--source-url", "https://example.invalid/source"],
            ["self-check", "--generation-id", "generation"],
        ):
            with self.subTest(arguments=arguments):
                with (
                    redirect_stderr(io.StringIO()),
                    patch.object(cli, "load_file") as load_file_mock,
                    patch.object(cli, "load_url") as load_url_mock,
                    patch.object(cli, "prepare_generation") as prepare_mock,
                    self.assertRaises(SystemExit) as raised,
                ):
                    cli.main(arguments)
                self.assertEqual(raised.exception.code, 2)
                load_file_mock.assert_not_called()
                load_url_mock.assert_not_called()
                prepare_mock.assert_not_called()

    def test_prepare_subcommand_preserves_generation_flow(self) -> None:
        output = _BinaryStdout()
        loaded = SimpleNamespace(rows=({"row": "fixture"},), audit="source-audit")
        dataset_lock = {"schema_version": "v1", "lock_type": "dataset"}
        arguments = self._prepare_arguments()
        with (
            patch.dict(os.environ, {"REPOFIX_PREPARER_IMAGE_ID": _IMAGE_ID}, clear=True),
            patch.object(cli.sys, "stdout", output),
            patch.object(cli, "load_url", return_value=loaded) as load_url_mock,
            patch.object(
                cli,
                "prepare_generation",
                return_value=dataset_lock,
            ) as prepare_mock,
        ):
            exit_code = cli.main(arguments)

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(output.buffer.getvalue()), dataset_lock)
        load_url_mock.assert_called_once_with(
            arguments[2],
            DATASET_SOURCE_SHA256,
        )
        rows, request = prepare_mock.call_args.args
        self.assertEqual(rows, loaded.rows)
        self.assertEqual(request.generation_id, "generation-1")
        self.assertEqual(request.public_volume, "dataset-public-generation-1")
        self.assertEqual(request.control_volume, "dataset-control-generation-1")
        self.assertEqual(request.private_volume, "dataset-private-generation-1")
        self.assertEqual(request.created_by_image_id, _IMAGE_ID)
        self.assertEqual(request.source_audit, "source-audit")

    def test_invalid_request_metadata_never_calls_a_source_loader(self) -> None:
        cases = (
            ("generation", "--generation-id", "INVALID", _IMAGE_ID),
            ("public_volume", "--public-volume", "wrong-public", _IMAGE_ID),
            ("control_volume", "--control-volume", "wrong-control", _IMAGE_ID),
            ("private_volume", "--private-volume", "wrong-private", _IMAGE_ID),
            ("image_id", None, None, "sha256:not-an-image-id"),
            ("source_sha", "--source-sha256", "0" * 64, _IMAGE_ID),
            ("source_url", "--source-url", "https://example.invalid/source", _IMAGE_ID),
        )
        for name, option, invalid_value, image_id in cases:
            with self.subTest(name=name):
                arguments = self._prepare_arguments()
                if option is not None:
                    assert invalid_value is not None
                    arguments[arguments.index(option) + 1] = invalid_value
                with (
                    redirect_stderr(io.StringIO()),
                    patch.dict(
                        os.environ,
                        {"REPOFIX_PREPARER_IMAGE_ID": image_id},
                        clear=True,
                    ),
                    patch.object(cli, "load_file") as load_file_mock,
                    patch.object(cli, "load_url") as load_url_mock,
                    patch.object(cli, "prepare_generation") as prepare_mock,
                ):
                    exit_code = cli.main(arguments)

                self.assertEqual(exit_code, 1)
                load_file_mock.assert_not_called()
                load_url_mock.assert_not_called()
                prepare_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
