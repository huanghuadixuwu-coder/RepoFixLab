from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import sys

from runtime_tools import RepositoryToolExecutor, RuntimeToolError


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
