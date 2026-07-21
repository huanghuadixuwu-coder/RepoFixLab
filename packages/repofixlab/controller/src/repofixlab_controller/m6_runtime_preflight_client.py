import json
import sys
import urllib.request
from typing import Any

from repofixlab_controller.runtime_journal import runtime_request_sha256


def call(path: str, request: dict[str, Any]) -> dict[str, Any]:
    request["request_sha256"] = runtime_request_sha256(request)
    body = json.dumps(request, sort_keys=True, separators=(",", ":")).encode("utf-8")
    response = urllib.request.urlopen(
        urllib.request.Request(
            "http://127.0.0.1:8000" + path,
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        ),
        timeout=180,
    )
    return {
        "status": response.status,
        "replay": response.headers.get("X-RepoFixLab-Idempotent-Replay"),
        "body": json.loads(response.read().decode("utf-8")),
    }


def main() -> None:
    preflight = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if not isinstance(preflight, dict):
        raise ValueError("runtime preflight request must be an object")
    preflight_response = call("/internal/v1/runtime/preflight", preflight)
    prepare = {
        "schema_version": "v1",
        "request_type": "runtime_prepare_worker",
        "attempt_id": preflight["attempt_id"],
        "operation_id": preflight["operation_id"] + ":prepare",
        "candidate_id": preflight["candidate_id"],
        "instance_id": preflight["instance_id"],
    }
    prepare_response = call("/internal/v1/runtime/workers/prepare", prepare)
    abort = {
        "schema_version": "v1",
        "request_type": "runtime_abort_attempt",
        "attempt_id": preflight["attempt_id"],
        "operation_id": preflight["operation_id"] + ":abort",
    }
    abort_response = call("/internal/v1/runtime/attempts/" + preflight["attempt_id"] + "/abort", abort)
    print(json.dumps({"preflight": preflight_response, "prepare": prepare_response, "abort": abort_response}, sort_keys=True))


if __name__ == "__main__":
    main()
