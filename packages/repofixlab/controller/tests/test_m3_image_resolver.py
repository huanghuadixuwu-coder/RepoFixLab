from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep
import unittest

from repofixlab_controller.m3_image_resolver import (
    M3ImageResolutionConflict,
    M3ImageResolutionRequest,
    M3ImageResolutionService,
    request_sha256,
    resolve_official_image_lock,
)


def _instance_ids() -> tuple[str, ...]:
    return tuple(f"preactjs__preact-{index:04d}" for index in range(43))


def _eligible_instance_ids() -> tuple[str, ...]:
    return _instance_ids()[:26]


class _Image:
    def __init__(self, reference: str) -> None:
        digest = ("a" if reference.endswith("0000:latest") else "b") * 64
        self.id = f"sha256:{digest}"
        self.attrs = {
            "Id": self.id,
            "Os": "linux",
            "Architecture": "amd64",
            "RepoDigests": [f"{reference.rsplit(':', 1)[0]}@sha256:{digest}"],
        }


class _Images:
    def __init__(self) -> None:
        self.references: list[str] = []

    def pull(self, repository: str, *, platform: str) -> _Image:
        assert platform == "linux/amd64"
        self.references.append(repository)
        return _Image(repository)

    def get(self, name: str) -> _Image:
        self.references.append(name)
        return _Image(name)


class _CachedImages(_Images):
    def pull(self, repository: str, *, platform: str) -> _Image:
        raise RuntimeError("registry is unavailable")


class _Client:
    def __init__(self) -> None:
        self.images = _Images()


class _CachedClient:
    def __init__(self) -> None:
        self.images = _CachedImages()


def _request(operation_id: str = "m3:resolve:0001") -> M3ImageResolutionRequest:
    return M3ImageResolutionRequest(
        operation_id=operation_id,
        dataset_revision="2b7aced941b4873e9cad3e76abbae93f481d1beb",
        instance_ids=_instance_ids(),
    )


def _eligible_request(operation_id: str = "m3:resolve:eligible:0001") -> M3ImageResolutionRequest:
    return M3ImageResolutionRequest(
        operation_id=operation_id,
        dataset_revision="2b7aced941b4873e9cad3e76abbae93f481d1beb",
        instance_ids=_eligible_instance_ids(),
    )


class M3ImageResolverTests(unittest.TestCase):
    def test_resolves_all_43_images_with_mechanical_references(self) -> None:
        client = _Client()
        lock = resolve_official_image_lock(client, _request(), resolved_at="2026-07-19T00:00:00.000Z")

        self.assertEqual(len(client.images.references), 43)
        self.assertEqual(client.images.references[0], "swebench/sweb.eval.x86_64.preactjs_1776_preact-0000:latest")
        self.assertTrue(str(lock["lock_id"]).startswith("official-images-v1-set-43-"))
        self.assertEqual(lock["created_at"], "2026-07-19T00:00:00.000Z")
        self.assertTrue(all(image["resolved_at"] == lock["created_at"] for image in lock["images"]))
        later_lock = resolve_official_image_lock(
            _Client(),
            _request(),
            resolved_at="2026-07-19T01:00:00.000Z",
        )
        self.assertEqual(later_lock["seal_sha256"], lock["seal_sha256"])
        self.assertEqual(later_lock["lock_id"], lock["lock_id"])

    def test_resolves_a_sealed_26_task_eligible_subset(self) -> None:
        client = _Client()
        lock = resolve_official_image_lock(client, _eligible_request(), resolved_at="2026-07-20T00:00:00.000Z")

        self.assertEqual(len(client.images.references), 26)
        self.assertTrue(str(lock["lock_id"]).startswith("official-images-v1-set-26-"))
        self.assertEqual(len(lock["images"]), 26)

    def test_persists_idempotent_results_and_rejects_conflicts(self) -> None:
        client = _Client()
        with TemporaryDirectory() as temporary_directory:
            service = M3ImageResolutionService(client, Path(temporary_directory))
            first, replayed = service.resolve(_request())
            second, replayed_second = service.resolve(_request())

            self.assertFalse(replayed)
            self.assertTrue(replayed_second)
            self.assertEqual(second, first)
            self.assertEqual(len(client.images.references), 43)
            self.assertEqual(request_sha256(_request()), request_sha256(_request()))
            changed_instance_ids = list(_instance_ids())
            changed_instance_ids[0] = "preactjs__preact-0000a"
            with self.assertRaises(M3ImageResolutionConflict):
                service.resolve(
                    M3ImageResolutionRequest(
                        operation_id="m3:resolve:0001",
                        dataset_revision="2b7aced941b4873e9cad3e76abbae93f481d1beb",
                        instance_ids=tuple(changed_instance_ids),
                    )
                )

    def test_background_resolution_persists_progress_and_completion(self) -> None:
        client = _Client()
        with TemporaryDirectory() as temporary_directory:
            service = M3ImageResolutionService(client, Path(temporary_directory))
            record, replayed = service.start(_request("m3:background:0001"))

            self.assertFalse(replayed)
            self.assertEqual(record["status"], "running")
            deadline = monotonic() + 5
            while record["status"] == "running" and monotonic() < deadline:
                sleep(0.01)
                record, replayed = service.start(_request("m3:background:0001"))

            self.assertTrue(replayed)
            self.assertEqual(record["status"], "completed")
            self.assertEqual(record["completed_image_count"], 43)
            self.assertIsInstance(record.get("official_image_source_lock"), dict)
            self.assertEqual(len(client.images.references), 43)

    def test_uses_exactly_verified_local_cache_when_registry_pull_fails(self) -> None:
        client = _CachedClient()
        lock = resolve_official_image_lock(client, _request(), resolved_at="2026-07-19T00:00:00.000Z")

        self.assertEqual(len(client.images.references), 43)
        self.assertTrue(all(reference.startswith("swebench/sweb.eval.x86_64.") for reference in client.images.references))
        self.assertTrue(str(lock["lock_id"]).startswith("official-images-v1-set-43-"))
