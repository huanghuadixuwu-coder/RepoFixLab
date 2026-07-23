from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import sys

from runtime_tools import (
    RepositoryToolExecutor,
    RuntimeToolError,
    RuntimeVerificationObservation,
    RuntimeVerificationResult,
)


_ROOT = Path(__file__).resolve().parent
_FILES = ("runtime_tools.py", "runtime_worker_entry.py")


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _aggregate() -> str:
    files: list[dict[str, object]] = []
    for name in _FILES:
        content = (_ROOT / name).read_bytes()
        files.append(
            {
                "path": name,
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    return hashlib.sha256(_canonical_bytes({"files": files})).hexdigest()


def _decode_request(value: str) -> dict[str, object]:
    try:
        raw = base64.b64decode(value, validate=True)
        request = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeToolError("worker tool request is malformed") from error
    if not isinstance(request, dict) or set(request) != {"tool", "input"}:
        raise RuntimeToolError("worker tool request envelope is not exact")
    tool = request.get("tool")
    tool_input = request.get("input")
    if not isinstance(tool, str) or not isinstance(tool_input, dict):
        raise RuntimeToolError("worker tool request fields are malformed")
    return request


def _tool(encoded: str) -> dict[str, object]:
    request = _decode_request(encoded)
    result = RepositoryToolExecutor(Path("/testbed")).execute(
        request["tool"],
        request["input"],
    )
    return {
        "schema_version": "v1",
        "response_type": "runtime_worker_tool_result",
        "result": result.to_dict(),
    }


def _snapshot() -> dict[str, object]:
    snapshot = RepositoryToolExecutor(Path("/testbed")).snapshot_evidence()
    return {
        "schema_version": "v1",
        "response_type": "runtime_worker_snapshot",
        "patch_base64": base64.b64encode(snapshot.patch).decode("ascii"),
        "base_commit": snapshot.base_commit,
        "base_tree": snapshot.base_tree,
        "candidate_tree": snapshot.candidate_tree,
        "files": [
            {"path": file.path, "status": file.status}
            for file in snapshot.files
        ],
        "policy": {
            "status": snapshot.policy_status,
            "violations": list(snapshot.policy_violations),
        },
    }


def _verification_catalog() -> dict[str, object]:
    catalog = RepositoryToolExecutor(Path("/testbed")).verification_catalog()
    return {
        "schema_version": "v1",
        "response_type": "runtime_worker_verification_catalog",
        "catalog": catalog.public_dict(),
    }


def _verification(encoded: str) -> dict[str, object]:
    try:
        raw = base64.b64decode(encoded, validate=True)
        request = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeToolError("worker verification request is malformed") from error
    if not isinstance(request, dict) or set(request) != {"catalog_id", "candidate_id", "patch_base64"}:
        raise RuntimeToolError("worker verification request envelope is not exact")
    catalog_id = request.get("catalog_id")
    candidate_id = request.get("candidate_id")
    patch_base64 = request.get("patch_base64")
    if not isinstance(catalog_id, str) or not isinstance(candidate_id, str) or not isinstance(patch_base64, str):
        raise RuntimeToolError("worker verification request fields are malformed")
    try:
        patch = base64.b64decode(patch_base64, validate=True)
    except ValueError as error:
        raise RuntimeToolError("worker verification patch is malformed") from error
    executor = RepositoryToolExecutor(Path("/testbed"))
    catalog = executor.verification_catalog()
    if catalog.catalog_id != catalog_id:
        result = RuntimeVerificationResult(
            catalog_id=catalog_id,
            candidate_id=candidate_id,
            status="environment_failure",
            reason_code="catalog_entry_stale",
            safe_hint="The verification catalog changed after planning; continue with the recorded outcome.",
            exit_code=None,
            stdout="",
            stderr="",
            truncated=False,
            timed_out=False,
            duration_ms=0,
            baseline=RuntimeVerificationObservation(
                status="environment_failure",
                reason_code="catalog_entry_stale",
                safe_hint="The verification catalog changed after planning; continue with the recorded outcome.",
                exit_code=None,
                stdout="",
                stderr="",
                truncated=False,
                timed_out=False,
                duration_ms=0,
            ),
        )
    else:
        result = executor.verify_catalog_entry(catalog, candidate_id, patch)
    return {
        "schema_version": "v1",
        "response_type": "runtime_worker_verification_result",
        "result": result.to_dict(),
    }


def main() -> int:
    try:
        if sys.argv[1:] == ["self-check"]:
            response: dict[str, object] = {
                "schema_version": "v1",
                "response_type": "runtime_worker_self_check",
                "aggregate_sha256": _aggregate(),
            }
        elif len(sys.argv) == 3 and sys.argv[1] == "tool":
            response = _tool(sys.argv[2])
        elif sys.argv[1:] == ["snapshot"]:
            response = _snapshot()
        elif sys.argv[1:] == ["verification-catalog"]:
            response = _verification_catalog()
        elif len(sys.argv) == 3 and sys.argv[1] == "verify":
            response = _verification(sys.argv[2])
        else:
            raise RuntimeToolError("worker command is not allowlisted")
        sys.stdout.buffer.write(_canonical_bytes(response))
        return 0
    except (
        RuntimeToolError,
        OSError,
        UnicodeError,
        ValueError,
        json.JSONDecodeError,
    ):
        sys.stderr.write("repofixlab worker runtime failed closed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
