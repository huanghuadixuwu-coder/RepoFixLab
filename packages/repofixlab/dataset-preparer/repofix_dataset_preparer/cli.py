from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Sequence

from .canonical import canonical_json
from .errors import PreparationError
from .prepare import (
    PreparationRequest,
    prepare_generation,
    validate_preparation_request_metadata,
)
from .self_check import build_self_check_report
from .source import load_file, load_url, validate_source_request


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="repofix-dataset-preparer")
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare")
    source = prepare.add_mutually_exclusive_group(required=True)
    source.add_argument("--source-file", type=Path)
    source.add_argument("--source-url")
    prepare.add_argument("--source-sha256", required=True)
    prepare.add_argument("--generation-id", required=True)
    prepare.add_argument("--public-volume", required=True)
    prepare.add_argument("--control-volume", required=True)
    prepare.add_argument("--private-volume", required=True)

    commands.add_parser("self-check")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.command == "self-check":
        report = build_self_check_report()
        sys.stdout.buffer.write(canonical_json(report))
        sys.stdout.buffer.flush()
        return 0 if report["status"] == "pass" else 1

    try:
        image_id = os.environ.get("REPOFIX_PREPARER_IMAGE_ID", "")
        validate_preparation_request_metadata(
            generation_id=arguments.generation_id,
            public_volume=arguments.public_volume,
            control_volume=arguments.control_volume,
            private_volume=arguments.private_volume,
            created_by_image_id=image_id,
        )
        source_file = validate_source_request(
            source_file=arguments.source_file,
            source_url=arguments.source_url,
            expected_sha256=arguments.source_sha256,
        )
        if arguments.source_url is not None:
            loaded = load_url(arguments.source_url, arguments.source_sha256)
        else:
            assert source_file is not None
            loaded = load_file(source_file, arguments.source_sha256)

        request = PreparationRequest(
            generation_id=arguments.generation_id,
            public_root=Path("/data/public"),
            control_root=Path("/data/control"),
            private_root=Path("/data/private"),
            public_volume=arguments.public_volume,
            control_volume=arguments.control_volume,
            private_volume=arguments.private_volume,
            created_by_image_id=image_id,
            source_audit=loaded.audit,
        )
        dataset_lock = prepare_generation(loaded.rows, request)
        sys.stdout.buffer.write(canonical_json(dataset_lock))
        sys.stdout.buffer.flush()
        return 0
    except (PreparationError, OSError) as error:
        json.dump(
            {
                "schema_version": "v1",
                "error_type": "dataset_preparation_failed",
                "message": str(error),
            },
            sys.stderr,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        sys.stderr.write("\n")
        return 1
