from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from repofixlab_controller import m3_preflight
from repofixlab_controller.m3_preflight import (
    M3PreflightError,
    M3PreflightRequest,
    M3PreflightService,
    M3PreflightTask,
    _request_sha256,
    validate_request,
)


class _Container:
    id = "container"

    def __init__(self, status_code: int) -> None:
        self._status_code = status_code

    def wait(self, timeout: int) -> dict[str, int]:
        return {"StatusCode": self._status_code}

    def logs(self, *, stdout: bool, stderr: bool) -> bytes:
        return b""

    def remove(self, *, force: bool) -> None:
        return None

    def put_archive(self, path: str, data: bytes) -> bool:
        return True


class _Containers:
    def __init__(self) -> None:
        self.permission_kwargs: dict[str, object] | None = None

    def create(self, image: str, command: list[str], **kwargs: object) -> _Container:
        return _Container(0)

    def run(self, image: str, command: list[str], **kwargs: object) -> _Container:
        self.permission_kwargs = kwargs
        return _Container(1)


class _Volume:
    def __init__(self, name: str) -> None:
        self.name = name

    def remove(self, *, force: bool) -> None:
        return None


class _Volumes:
    def __init__(self) -> None:
        self._index = 0

    def create(self, *, name: str, labels: dict[str, str]) -> _Volume:
        self._index += 1
        return _Volume(f"{name}-{self._index}")


class _Image:
    id = "sha256:" + "c" * 64


class _Images:
    def get(self, name: str) -> _Image:
        return _Image()


class _Client:
    def __init__(self) -> None:
        self.containers = _Containers()
        self.volumes = _Volumes()
        self.images = _Images()


def request() -> M3PreflightRequest:
    return M3PreflightRequest(
        operation_id="m3:preflight:0001",
        dataset_revision="2b7aced941b4873e9cad3e76abbae93f481d1beb",
        private_volume="dataset-private-g-20260718-135934-066a8f5b6f6b",
        tasks=tuple(
            M3PreflightTask(
                instance_id=f"preactjs__preact-{index:04d}",
                base_commit="a" * 40,
                repo="preactjs/preact",
                private_task_sha256="b" * 64,
                source_image_id="sha256:" + "c" * 64,
            )
            for index in range(43)
        ),
    )


class M3PreflightRequestTests(unittest.TestCase):
    def test_accepts_a_sorted_complete_sealed_task_set(self) -> None:
        value = request()
        self.assertEqual(validate_request(value), value)
        self.assertEqual(_request_sha256(value), _request_sha256(value))

    def test_rejects_partial_or_unsorted_task_sets(self) -> None:
        value = request()
        with self.assertRaises(M3PreflightError):
            validate_request(
                M3PreflightRequest(
                    operation_id=value.operation_id,
                    dataset_revision=value.dataset_revision,
                    private_volume=value.private_volume,
                    tasks=value.tasks[:-1],
                )
            )

    def test_accepts_a_26_task_environment_preflight_with_sealed_adapted_images(self) -> None:
        value = request()
        adapted = tuple(
            M3PreflightTask(
                instance_id=task.instance_id,
                base_commit=task.base_commit,
                repo=task.repo,
                private_task_sha256=task.private_task_sha256,
                source_image_id=task.source_image_id,
                adapted_image_reference=f"repofixlab-m6-{index:02d}-evaluator:v1",
                adapted_image_id="sha256:" + "d" * 64,
            )
            for index, task in enumerate(value.tasks[:26])
        )
        accepted = M3PreflightRequest(
            operation_id="m6:environment-preflight:0001",
            dataset_revision=value.dataset_revision,
            private_volume=value.private_volume,
            tasks=adapted,
        )
        self.assertEqual(validate_request(accepted), accepted)
        with self.assertRaises(M3PreflightError):
            validate_request(
                M3PreflightRequest(
                    operation_id=value.operation_id,
                    dataset_revision=value.dataset_revision,
                    private_volume=value.private_volume,
                    tasks=tuple(reversed(value.tasks)),
                )
            )

    def test_initializes_the_private_derivative_volume_as_root(self) -> None:
        value = request()
        client = _Client()
        with TemporaryDirectory() as temporary_directory:
            kernel_path = Path(temporary_directory) / "m3_task_kernel.py"
            kernel_path.write_text("print('kernel')\n", encoding="utf-8")
            service = M3PreflightService(
                client,
                Path(temporary_directory),
                value.private_volume,
            )
            with patch.object(m3_preflight, "KERNEL_PATH", kernel_path):
                with self.assertRaises(M3PreflightError):
                    service._run_task(value, value.tasks[0])
        self.assertIsNotNone(client.containers.permission_kwargs)
        self.assertEqual(client.containers.permission_kwargs.get("user"), "0:0")


if __name__ == "__main__":
    unittest.main()
