from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from repofixlab_evaluator.canonical import canonical_json, sha256_bytes, sha256_file
from repofixlab_evaluator.errors import OfficialSourceError
from repofixlab_evaluator.integrity import directory_aggregate
from repofixlab_evaluator import pristine_runtime


class DirectoryAggregateTests(unittest.TestCase):
    def test_aggregate_detects_file_content_and_addition_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.py").write_text("first\n", encoding="utf-8")
            original = directory_aggregate(root)
            (root / "a.py").write_text("second\n", encoding="utf-8")
            self.assertNotEqual(directory_aggregate(root), original)
            (root / "extra.txt").write_text("extra\n", encoding="utf-8")
            self.assertNotEqual(directory_aggregate(root)[1], original[1])

    @unittest.skipIf(os.name == "nt", "Windows symlink creation requires optional privileges")
    def test_aggregate_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.py"
            target.write_text("target\n", encoding="utf-8")
            (root / "link.py").symlink_to(target)
            with self.assertRaises(OfficialSourceError):
                directory_aggregate(root)


class ProvenanceTests(unittest.TestCase):
    def test_load_provenance_is_bound_to_environment_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "provenance.json"
            unsigned: dict[str, object] = {
                "schema_version": "v1",
                "artifact_type": "repofixlab_pristine_harness",
                "platform": "linux/amd64",
                "base_image": "base@sha256:" + "a" * 64,
                "upstream_revision": "b" * 40,
                "upstream_tree_sha1": "c" * 40,
                "source_archive_sha256": "d" * 64,
                "source_lock_sha256": "e" * 64,
                "source_aggregate_sha256": "f" * 64,
                "dependency_lock_sha256": "1" * 64,
                "evaluator_kernel_aggregate_sha256": "2" * 64,
                "evaluator_kernel_file_count": 12,
                "evaluator_kernel_bytes": 1200,
                "dockerfile_sha256": "3" * 64,
            }
            provenance = {
                **unsigned,
                "provenance_sha256": sha256_bytes(canonical_json(unsigned)),
            }
            path.write_bytes(canonical_json(provenance))
            with (
                patch.object(pristine_runtime, "PROVENANCE_PATH", path),
                patch.dict(os.environ, {"REPOFIXLAB_PROVENANCE_SHA256": str(provenance["provenance_sha256"])}),
            ):
                self.assertEqual(pristine_runtime._load_provenance(), provenance)

    def test_load_provenance_rejects_lock_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "provenance.json"
            path.write_text("{}\n", encoding="utf-8")
            with patch.object(pristine_runtime, "PROVENANCE_PATH", path):
                with self.assertRaises(OfficialSourceError):
                    pristine_runtime._load_provenance()


if __name__ == "__main__":
    unittest.main()
