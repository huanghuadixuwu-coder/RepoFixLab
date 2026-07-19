from __future__ import annotations

import json
import stat
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from repofix_dataset_preparer.errors import PreparationError
from repofix_dataset_preparer.constants import (
    DATASET_SOURCE_BYTES,
    DATASET_SOURCE_SHA256,
    EXPECTED_SOURCE_RECORD_COUNT,
)
from repofix_dataset_preparer.prepare import (
    PreparationRequest,
    prepare_generation,
    verify_generation,
)
from repofix_dataset_preparer.source import SourceAudit

from tests.fakes import make_rows

_IMAGE_ID = "sha256:" + "a" * 64


class PrepareTest(unittest.TestCase):
    def _request(self, root: Path, generation: str = "fixture-generation") -> PreparationRequest:
        public = root / "public"
        control = root / "control"
        private = root / "private"
        public.mkdir()
        control.mkdir()
        private.mkdir()
        return PreparationRequest(
            generation_id=generation,
            public_root=public,
            control_root=control,
            private_root=private,
            public_volume=f"dataset-public-{generation}",
            control_volume=f"dataset-control-{generation}",
            private_volume=f"dataset-private-{generation}",
            created_by_image_id=_IMAGE_ID,
            source_audit=SourceAudit(
                source_kind="file",
                source_sha256=DATASET_SOURCE_SHA256,
                source_bytes=DATASET_SOURCE_BYTES,
                requested_url=None,
                final_url=None,
                redirect_chain=(),
            ),
            require_mounts=False,
        )

    def test_materializes_and_verifies_three_sealed_scopes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._request(root)
            lock = prepare_generation(
                make_rows(),
                request,
                clock=lambda: "2026-07-18T00:00:00Z",
            )
            roots = {
                "public": request.public_root,
                "control": request.control_root,
                "private": request.private_root,
            }
            verify_generation(lock, roots)
            self.assertEqual(lock["record_count"], 43)
            self.assertEqual(len(make_rows()), EXPECTED_SOURCE_RECORD_COUNT)
            for scope_root in roots.values():
                self.assertEqual(stat.S_IMODE(scope_root.stat().st_mode), 0o755)
                for path in scope_root.rglob("*"):
                    if path.is_dir():
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
                    elif path.is_file():
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o444)
                    else:
                        self.fail(f"unexpected dataset entry type: {path}")
            # Dataset volume topology controls scope authorization; readable immutable
            # files allow authorized containers with distinct non-root UIDs to consume it.

            self.assertTrue(all((path / "SEAL").is_file() for path in roots.values()))
            public_text = (request.public_root / "tasks.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("gold_patch", public_text)
            self.assertNotIn("test_patch", public_text)
            control = json.loads(
                (request.control_root / "tasks" / "axios__axios-5892.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(control["issue_bytes"], 31)
            self.assertEqual(control["gold_changed_lines"], 2)

    def test_rejects_wrong_count_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))
            with self.assertRaises(PreparationError):
                prepare_generation(make_rows()[:-1], request)
            self.assertEqual(list(request.public_root.iterdir()), [])
            self.assertEqual(
                [path.name for path in request.control_root.iterdir()], ["WRITER"]
            )
            self.assertEqual(list(request.private_root.iterdir()), [])
            self.assertFalse((request.control_root / "READY").exists())
            self.assertFalse((request.control_root / "SEAL").exists())

    def test_rejects_repo_distribution_drift_even_when_subset_total_is_43(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))
            rows = make_rows()
            babel = next(row for row in rows if row.get("repo") == "babel/babel")
            babel["repo"] = "vuejs/core"
            with self.assertRaisesRegex(PreparationError, "repository counts differ"):
                prepare_generation(rows, request)
            self.assertFalse((request.control_root / "READY").exists())
            self.assertFalse((request.control_root / "SEAL").exists())

    def test_rejects_duplicate_instance_id_across_all_300_source_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))
            rows = make_rows()
            rows[-1]["instance_id"] = rows[0]["instance_id"]
            with self.assertRaisesRegex(PreparationError, "duplicate source instance_id"):
                prepare_generation(rows, request)
            self.assertFalse((request.control_root / "READY").exists())

    def test_rejects_non_frozen_source_audit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))
            request = replace(
                request,
                source_audit=replace(request.source_audit, source_sha256="b" * 64),
            )
            with self.assertRaisesRegex(PreparationError, "frozen dataset object"):
                prepare_generation(make_rows(), request)
            self.assertEqual(list(request.control_root.iterdir()), [])

    def test_rejects_non_frozen_source_size_audit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))
            request = replace(
                request,
                source_audit=replace(
                    request.source_audit,
                    source_bytes=DATASET_SOURCE_BYTES + 1,
                ),
            )
            with self.assertRaisesRegex(PreparationError, "byte count"):
                prepare_generation(make_rows(), request)
            self.assertEqual(list(request.control_root.iterdir()), [])

    def test_prepare_generation_defensively_revalidates_request_metadata(self) -> None:
        replacements = (
            {"generation_id": "INVALID"},
            {"public_volume": "wrong-public-volume"},
            {"created_by_image_id": "sha256:not-an-image-id"},
        )
        for request_replacement in replacements:
            with self.subTest(request_replacement=request_replacement):
                with tempfile.TemporaryDirectory() as temporary:
                    request = replace(
                        self._request(Path(temporary)),
                        **request_replacement,
                    )
                    with self.assertRaises(PreparationError):
                        prepare_generation(make_rows(), request)
                    self.assertEqual(list(request.public_root.iterdir()), [])
                    self.assertEqual(list(request.control_root.iterdir()), [])
                    self.assertEqual(list(request.private_root.iterdir()), [])

    def test_refuses_to_overwrite_nonempty_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))
            sentinel = request.private_root / "SEAL"
            sentinel.write_text("existing", encoding="utf-8")
            with self.assertRaises(PreparationError):
                prepare_generation(make_rows(), request)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "existing")

    def test_partial_seal_is_not_verifiable_or_returned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))
            from repofix_dataset_preparer import prepare as prepare_module

            original = prepare_module._write_atomic

            def fail_private_seal(root: Path, relative_path: str, content: bytes) -> None:
                if root == request.private_root and relative_path == "SEAL":
                    raise OSError("injected termination")
                original(root, relative_path, content)

            with patch.object(prepare_module, "_write_atomic", side_effect=fail_private_seal):
                with self.assertRaisesRegex(PreparationError, "not published"):
                    prepare_generation(make_rows(), request)
            self.assertFalse((request.private_root / "SEAL").exists())
            fake_lock = {
                "schema_version": "v1",
                "lock_type": "dataset",
                "dataset": {
                    "name": "SWE-bench/SWE-bench_Multilingual",
                    "revision": "2b7aced941b4873e9cad3e76abbae93f481d1beb",
                },
                "record_count": 43,
                "files": [],
            }
            with self.assertRaises(PreparationError):
                verify_generation(
                    fake_lock,
                    {
                        "public": request.public_root,
                        "control": request.control_root,
                        "private": request.private_root,
                    },
                )

    def test_same_generation_allows_only_one_writer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            request = self._request(Path(temporary))

            def attempt() -> object:
                try:
                    return prepare_generation(
                        make_rows(), request, clock=lambda: "2026-07-18T00:00:00Z"
                    )
                except PreparationError as error:
                    return error

            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = list(executor.map(lambda _: attempt(), range(2)))
            locks = [outcome for outcome in outcomes if isinstance(outcome, dict)]
            errors = [outcome for outcome in outcomes if isinstance(outcome, PreparationError)]
            self.assertEqual(len(locks), 1)
            self.assertEqual(len(errors), 1)
            verify_generation(
                locks[0],
                {
                    "public": request.public_root,
                    "control": request.control_root,
                    "private": request.private_root,
                },
            )


if __name__ == "__main__":
    unittest.main()
