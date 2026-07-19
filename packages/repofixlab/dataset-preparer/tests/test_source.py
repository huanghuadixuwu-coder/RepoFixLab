from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from repofix_dataset_preparer.errors import PreparationError
from repofix_dataset_preparer.constants import (
    DATASET_REVISION,
    DATASET_SOURCE_PATH,
    DATASET_SOURCE_SHA256,
)
from repofix_dataset_preparer.source import (
    _parse_jsonl,
    _validate_expected_sha256,
    _validate_pinned_source_url,
    load_file,
    validate_source_request,
)


class SourceTest(unittest.TestCase):
    def test_parses_fake_jsonl_without_weakening_production_source_lock(self) -> None:
        content = (json.dumps({"instance_id": "x"}) + "\n").encode()
        rows = _parse_jsonl(content)
        self.assertEqual(rows[0]["instance_id"], "x")
        _validate_expected_sha256(DATASET_SOURCE_SHA256)

    def test_rejects_wrong_source_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.jsonl"
            path.write_text("{}\n", encoding="utf-8")
            with self.assertRaises(PreparationError):
                load_file(path, "0" * 64)

    def test_rejects_correct_hash_with_wrong_local_object_size(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / Path(DATASET_SOURCE_PATH).name
            path.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(PreparationError, "size"):
                load_file(path, DATASET_SOURCE_SHA256)

    def test_accepts_only_revision_bound_huggingface_urls(self) -> None:
        pinned_url = (
            "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual/"
            f"resolve/{DATASET_REVISION}/{DATASET_SOURCE_PATH}"
        )
        _validate_pinned_source_url(pinned_url)
        self.assertIsNone(
            validate_source_request(
                source_file=None,
                source_url=pinned_url,
                expected_sha256=DATASET_SOURCE_SHA256,
            )
        )
        with self.assertRaises(PreparationError):
            _validate_pinned_source_url(
                "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual/"
                "resolve/main/data/test.parquet"
            )
        with self.assertRaises(PreparationError):
            _validate_pinned_source_url(
                "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual/"
                f"resolve/{DATASET_REVISION}/data/other.parquet"
            )

    def test_local_source_request_outside_input_is_rejected_before_loading(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / Path(DATASET_SOURCE_PATH).name
            source.touch()

            with self.assertRaisesRegex(PreparationError, "mounted below /input"):
                validate_source_request(
                    source_file=source,
                    source_url=None,
                    expected_sha256=DATASET_SOURCE_SHA256,
                )

    def test_rejects_blank_jsonl_records(self) -> None:
        content = b"{}\n\n"
        with self.assertRaises(PreparationError):
            _parse_jsonl(content)


if __name__ == "__main__":
    unittest.main()
