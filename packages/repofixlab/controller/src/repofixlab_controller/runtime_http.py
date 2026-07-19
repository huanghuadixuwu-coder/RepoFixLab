from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Literal

from fastapi import FastAPI, HTTPException, Path
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .runtime_service import (
    RuntimeCapacityBusy,
    RuntimeInvalidState,
    RuntimeOperationConflict,
    RuntimeOperationResult,
    RuntimeOperationService,
    RuntimeRequestRejected,
    RuntimeResourceNotFound,
    RuntimeServiceUnavailable,
)
from .runtime_tools import RuntimeToolName


_IDENTIFIER_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"
_SHA256_PATTERN = r"^[a-f0-9]{64}$"


class _RuntimeWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: Literal["v1"]
    request_type: str
    attempt_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=_IDENTIFIER_PATTERN,
    )
    operation_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=_IDENTIFIER_PATTERN,
    )
    request_sha256: str = Field(pattern=_SHA256_PATTERN)


class RuntimePreflightRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_preflight"]
    candidate_id: str = Field(min_length=1, max_length=160)
    instance_id: str = Field(min_length=1, max_length=160)


class RuntimePrepareWorkerRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_prepare_worker"]
    candidate_id: str = Field(min_length=1, max_length=160)
    instance_id: str = Field(min_length=1, max_length=160)


class RuntimeExecuteToolRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_execute_tool"]
    tool: RuntimeToolName
    input: dict[str, object]


class RuntimeSnapshotPatchRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_snapshot_patch"]


class RuntimeDestroyWorkerRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_destroy_worker"]


class RuntimeStartEvaluationRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_start_evaluation"]
    run_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=_IDENTIFIER_PATTERN,
    )
    snapshot_id: str = Field(
        min_length=73,
        max_length=73,
        pattern=r"^snapshot-[a-f0-9]{64}$",
    )


class RuntimeAcknowledgeArtifactsRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_ack_artifacts"]
    artifact_set_sha256: str = Field(pattern=_SHA256_PATTERN)


class RuntimeAbortAttemptRequest(_RuntimeWriteRequest):
    request_type: Literal["runtime_abort_attempt"]


def install_runtime_routes(application: FastAPI) -> None:
    @application.post("/internal/v1/runtime/preflight")
    def runtime_preflight(request: RuntimePreflightRequest) -> JSONResponse:
        return _write_call(application, lambda service: service.preflight(_body(request)))

    @application.post("/internal/v1/runtime/workers/prepare")
    def runtime_prepare_worker(request: RuntimePrepareWorkerRequest) -> JSONResponse:
        return _write_call(
            application,
            lambda service: service.prepare_worker(_body(request)),
        )

    @application.post("/internal/v1/runtime/workers/{lease_id}/tools")
    def runtime_execute_tool(
        request: RuntimeExecuteToolRequest,
        lease_id: str = Path(pattern=_IDENTIFIER_PATTERN),
    ) -> JSONResponse:
        return _write_call(
            application,
            lambda service: service.execute_tool(
                {**_body(request), "lease_id": lease_id}
            ),
        )

    @application.post("/internal/v1/runtime/workers/{lease_id}/snapshot")
    def runtime_snapshot_patch(
        request: RuntimeSnapshotPatchRequest,
        lease_id: str = Path(pattern=_IDENTIFIER_PATTERN),
    ) -> JSONResponse:
        return _write_call(
            application,
            lambda service: service.snapshot_patch(
                {**_body(request), "lease_id": lease_id}
            ),
        )

    @application.post("/internal/v1/runtime/workers/{lease_id}/destroy")
    def runtime_destroy_worker(
        request: RuntimeDestroyWorkerRequest,
        lease_id: str = Path(pattern=_IDENTIFIER_PATTERN),
    ) -> JSONResponse:
        return _write_call(
            application,
            lambda service: service.destroy_worker(
                {**_body(request), "lease_id": lease_id}
            ),
        )

    @application.post("/internal/v1/runtime/evaluations")
    def runtime_start_evaluation(
        request: RuntimeStartEvaluationRequest,
    ) -> JSONResponse:
        return _write_call(
            application,
            lambda service: service.start_evaluation(_body(request)),
        )

    @application.get("/internal/v1/runtime/jobs/{job_id}")
    def runtime_get_job(
        job_id: str = Path(pattern=_IDENTIFIER_PATTERN),
    ) -> JSONResponse:
        return _read_call(application, lambda service: service.get_job(job_id))

    @application.get("/internal/v1/runtime/jobs/{job_id}/artifacts")
    def runtime_get_artifacts(
        job_id: str = Path(pattern=_IDENTIFIER_PATTERN),
    ) -> JSONResponse:
        return _read_call(application, lambda service: service.get_artifacts(job_id))

    @application.post("/internal/v1/runtime/jobs/{job_id}/ack")
    def runtime_acknowledge_artifacts(
        request: RuntimeAcknowledgeArtifactsRequest,
        job_id: str = Path(pattern=_IDENTIFIER_PATTERN),
    ) -> JSONResponse:
        return _write_call(
            application,
            lambda service: service.acknowledge_artifacts(
                {**_body(request), "job_id": job_id}
            ),
        )

    @application.post("/internal/v1/runtime/attempts/{attempt_id}/abort")
    def runtime_abort_attempt(
        request: RuntimeAbortAttemptRequest,
        attempt_id: str = Path(pattern=_IDENTIFIER_PATTERN),
    ) -> JSONResponse:
        if request.attempt_id != attempt_id:
            raise HTTPException(
                status_code=400,
                detail="runtime path attempt does not match request",
            )
        return _write_call(
            application,
            lambda service: service.abort_attempt(_body(request)),
        )


def _body(request: _RuntimeWriteRequest) -> dict[str, object]:
    return request.model_dump(mode="python")


def _runtime_service(application: FastAPI) -> RuntimeOperationService:
    service = getattr(application.state, "runtime_service", None)
    if not isinstance(service, RuntimeOperationService):
        raise HTTPException(status_code=503, detail="runtime service is unavailable")
    return service


def _write_call(
    application: FastAPI,
    callback: Callable[[RuntimeOperationService], RuntimeOperationResult],
) -> JSONResponse:
    try:
        result = callback(_runtime_service(application))
    except RuntimeRequestRejected:
        raise HTTPException(status_code=400, detail="runtime request was rejected") from None
    except RuntimeResourceNotFound:
        raise HTTPException(
            status_code=404, detail="runtime resource was not found"
        ) from None
    except (RuntimeOperationConflict, RuntimeInvalidState):
        raise HTTPException(
            status_code=409, detail="runtime operation conflicts with state"
        ) from None
    except RuntimeCapacityBusy:
        raise HTTPException(status_code=429, detail="runtime capacity is busy") from None
    except RuntimeServiceUnavailable:
        raise HTTPException(status_code=503, detail="runtime service is unavailable") from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="runtime operation failed") from None
    return JSONResponse(
        content=result.response,
        headers={
            "X-RepoFixLab-Idempotent-Replay": (
                "true" if result.replayed else "false"
            )
        },
    )


def _read_call(
    application: FastAPI,
    callback: Callable[[RuntimeOperationService], Mapping[str, object]],
) -> JSONResponse:
    try:
        response = callback(_runtime_service(application))
    except RuntimeResourceNotFound:
        raise HTTPException(
            status_code=404, detail="runtime resource was not found"
        ) from None
    except RuntimeInvalidState:
        raise HTTPException(
            status_code=409, detail="runtime operation conflicts with state"
        ) from None
    except RuntimeServiceUnavailable:
        raise HTTPException(status_code=503, detail="runtime service is unavailable") from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="runtime operation failed") from None
    return JSONResponse(content=dict(response))
