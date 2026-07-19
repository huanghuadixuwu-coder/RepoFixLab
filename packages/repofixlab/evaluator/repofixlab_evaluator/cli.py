from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .agent_patch import evaluate_agent_patch
from .canonical import canonical_json
from .errors import EvaluationError
from .official_oracle import normalize_pristine_report, run_official_oracle
from .private_spec import load_private_spec
from .runner import EvaluationKernel


def _write_exclusive(path: Path, content: bytes) -> None:
    descriptor = os.open(
        path,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _validate_output(path: Path, evidence_root: Path) -> None:
    root = evidence_root.resolve(strict=True)
    parent = path.parent.resolve(strict=True)
    try:
        parent.relative_to(root)
    except ValueError as error:
        raise EvaluationError("report output is outside the evidence root") from error
    if path.exists() or path.is_symlink():
        raise EvaluationError("report output already exists")


def _read_bytes(path: Path, maximum: int, allowed_root: Path) -> bytes:
    root = allowed_root.resolve(strict=True)
    if path.is_symlink():
        raise EvaluationError("evidence file violates path or size policy")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise EvaluationError("evidence file is outside its allowed root") from error
    if not resolved.is_file() or resolved.stat().st_size > maximum:
        raise EvaluationError("evidence file violates path or size policy")
    return resolved.read_bytes()


def _adapted(args: argparse.Namespace) -> dict[str, object]:
    spec = load_private_spec(args.private_spec, args.private_root)
    kernel = EvaluationKernel(
        workspace=args.workspace,
        candidate_root=args.candidate_root,
        evidence_root=args.evidence_root,
        timeout_seconds=args.timeout_seconds,
    )
    return kernel.evaluate(
        probe_kind=args.probe_kind,
        spec=spec,
        official_source_lock_sha256=args.official_source_lock_sha256,
        pristine_runtime_lock_sha256=args.pristine_runtime_lock_sha256,
        candidate_path=args.candidate,
        log_output_path=args.log_output,
    )


def _pristine(args: argparse.Namespace) -> dict[str, object]:
    spec = load_private_spec(args.private_spec, args.private_root)
    test_log = (
        None
        if args.test_log is None
        else _read_bytes(args.test_log, 32 * 1024 * 1024, args.evidence_root)
    )
    official_report = _read_bytes(args.official_report, 1024 * 1024, args.evidence_root)
    metadata_value = json.loads(_read_bytes(args.metadata, 64 * 1024, args.evidence_root).decode("utf-8"))
    if not isinstance(metadata_value, dict):
        raise EvaluationError("pristine metadata is not an object")
    oracle, source_lock_sha256 = run_official_oracle(
        source_root=args.official_source_root,
        source_lock_path=args.official_source_lock,
        test_log=test_log or b"",
        spec=spec,
    )
    return normalize_pristine_report(
        metadata=metadata_value,
        oracle=oracle,
        source_lock_sha256=source_lock_sha256,
        pristine_runtime_lock_sha256=args.pristine_runtime_lock_sha256,
        test_log=test_log,
        official_report=official_report,
        spec=spec,
    )


def _agent_patch(args: argparse.Namespace) -> dict[str, object]:
    return evaluate_agent_patch(
        private_spec_path=args.private_spec,
        private_root=args.private_root,
        workspace=args.workspace,
        candidate_root=args.candidate_root,
        evidence_root=args.evidence_root,
        candidate_patch_sha256=args.candidate_patch_sha256,
        private_spec_sha256=args.private_spec_sha256,
        evaluation_id=args.evaluation_id,
        job_id=args.job_id,
        run_id=args.run_id,
        attempt_id=args.attempt_id,
        timeout_seconds=args.timeout_seconds,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="repofixlab-evaluator")
    subparsers = parser.add_subparsers(dest="mode", required=True)
    for mode in ("adapted", "pristine"):
        subparser = subparsers.add_parser(mode)
        subparser.add_argument("--private-spec", type=Path, required=True)
        subparser.add_argument("--private-root", type=Path, required=True)
        subparser.add_argument("--evidence-root", type=Path, required=True)
        subparser.add_argument("--report-output", type=Path, required=True)
    adapted = subparsers.choices["adapted"]
    adapted.add_argument("--workspace", type=Path, required=True)
    adapted.add_argument("--candidate-root", type=Path, required=True)
    adapted.add_argument("--probe-kind", choices=("base", "no_op", "malformed", "gold"), required=True)
    adapted.add_argument("--candidate", type=Path)
    adapted.add_argument("--official-source-lock-sha256", required=True)
    adapted.add_argument("--pristine-runtime-lock-sha256", required=True)
    adapted.add_argument("--log-output", type=Path, required=True)
    adapted.add_argument("--timeout-seconds", type=int, default=300, choices=range(1, 301))
    pristine = subparsers.choices["pristine"]
    pristine.add_argument("--official-source-root", type=Path, required=True)
    pristine.add_argument("--official-source-lock", type=Path, required=True)
    pristine.add_argument("--official-report", type=Path, required=True)
    pristine.add_argument("--test-log", type=Path)
    pristine.add_argument("--metadata", type=Path, required=True)
    pristine.add_argument("--pristine-runtime-lock-sha256", required=True)
    agent_patch = subparsers.add_parser("agent-patch")
    agent_patch.add_argument("--private-spec", type=Path, required=True)
    agent_patch.add_argument("--private-root", type=Path, required=True)
    agent_patch.add_argument("--workspace", type=Path, required=True)
    agent_patch.add_argument("--candidate-root", type=Path, required=True)
    agent_patch.add_argument("--candidate-patch-sha256", required=True)
    agent_patch.add_argument("--private-spec-sha256", required=True)
    agent_patch.add_argument("--evidence-root", type=Path, required=True)
    agent_patch.add_argument("--evaluation-id", required=True)
    agent_patch.add_argument("--job-id", required=True)
    agent_patch.add_argument("--run-id", required=True)
    agent_patch.add_argument("--attempt-id", required=True)
    agent_patch.add_argument("--timeout-seconds", type=int, default=300, choices=range(1, 301))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.mode == "agent-patch":
            report = _agent_patch(args)
            content = canonical_json(report)
            sys.stdout.buffer.write(content)
            return 0
        _validate_output(args.report_output, args.evidence_root)
        report = _adapted(args) if args.mode == "adapted" else _pristine(args)
        content = canonical_json(report)
        _write_exclusive(args.report_output, content)
        sys.stdout.buffer.write(content)
        return 0
    except (EvaluationError, OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        sys.stderr.write("repofixlab evaluator failed closed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
