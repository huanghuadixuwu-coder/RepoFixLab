"""Trusted Controller HTTP application and production service wiring.

This module:
- Builds the FastAPI process that owns privileged Controller services.
- Opens the local Docker SDK client only inside the Controller process.
- Constructs factory, runtime, image-resolution, and preflight services.
- Exposes bounded HTTP operations while closing owned resources on shutdown.

Trust boundary:
- Docker access and repository/container operations stay inside Controller.
- Model credentials, model selection, token budgets, and experiment scheduling
  remain owned by the Node Orchestrator and are not loaded here.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import json
from typing import Literal
import os
from pathlib import Path
from threading import Lock

import docker
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field

from .collector import collect_bootstrap_health, unreachable_bootstrap_health
from .factory_service import (
    FactoryCapacityBusy,
    FactoryHttpRequest,
    FactoryOperationConflict,
    FactoryOperationRejected,
    FactoryOperationService,
    FactoryServiceUnavailable,
    load_factory_operation_service,
)
from .m3_image_resolver import (
    M3ImageResolutionConflict,
    M3ImageResolutionError,
    M3ImageResolutionRequest,
    M3ImageResolutionService,
)
from .m3_preflight import (
    M3PreflightConflict,
    M3PreflightError,
    M3PreflightRequest,
    M3PreflightService,
    M3PreflightTask,
)
from .runtime_http import install_runtime_routes
from .runtime_docker import (
    DockerRuntimeBackend,
    RuntimeDockerConfiguration,
)
from .runtime_journal import RuntimeOperationJournal
from .runtime_service import RuntimeOperationService


def _bootstrap_health_validator() -> Draft202012Validator:
    """Load the frozen bootstrap-health schema used for fail-closed validation."""

    schema_path = Path(
        os.environ.get(
            "REPOFIXLAB_SCHEMA_PATH",
            "/opt/repofixlab/schemas/controller-bootstrap-health.schema.json",
        )
    )
    with schema_path.open("r", encoding="utf-8") as schema_file:
        schema = json.load(schema_file)
    return Draft202012Validator(schema)


BOOTSTRAP_HEALTH_VALIDATOR = _bootstrap_health_validator()
BOOTSTRAP_DOCTOR_LOCK = Lock()


class TaskRoleFactoryOperationRequest(BaseModel):
    """Validate one idempotent request for a trusted task-role factory probe."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    operation_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$",
    )
    candidate_id: str = Field(min_length=1, max_length=160)
    instance_id: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$",
    )


class M3OfficialImageResolutionRequest(BaseModel):
    """Validate one bounded batch request for resolving official task images."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: Literal["v1"]
    request_type: Literal["m3_official_image_resolution"]
    operation_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$",
    )
    dataset_revision: str = Field(min_length=7, max_length=160)
    instance_ids: list[str] = Field(min_length=26, max_length=43)


class M3PreflightTaskRequest(BaseModel):
    """Describe one task binding checked during official-image preflight."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    instance_id: str = Field(min_length=3, max_length=401)
    base_commit: str = Field(pattern=r"^[a-f0-9]{40}$")
    repo: str = Field(min_length=3, max_length=200)
    private_task_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_image_id: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    adapted_image_reference: str | None = Field(default=None, min_length=1, max_length=300)
    adapted_image_id: str | None = Field(default=None, pattern=r"^sha256:[a-f0-9]{64}$")


class M3OfficialPreflightRequest(BaseModel):
    """Validate a complete M3 preflight request against the frozen cohort size."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: Literal["v1"]
    request_type: Literal["m3_official_image_preflight"]
    operation_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
    dataset_revision: str = Field(min_length=7, max_length=160)
    private_volume: str = Field(min_length=1, max_length=100)
    tasks: list[M3PreflightTaskRequest] = Field(min_length=26, max_length=43)


def _load_factory_from_environment() -> tuple[FactoryOperationService | None, object | None]:
    """Create the trusted candidate factory and its owned Docker client."""

    candidate_directory_value = os.environ.get("REPOFIXLAB_FACTORY_CANDIDATE_DIR")
    if not candidate_directory_value:
        return None, None
    schema_directory = Path(
        os.environ.get("REPOFIXLAB_SCHEMA_DIR", "/opt/repofixlab/schemas")
    )
    operation_root = Path(
        os.environ.get(
            "REPOFIXLAB_FACTORY_OPERATION_ROOT",
            "/var/lib/repofix/controller/factory-operations",
        )
    )
    client = docker.from_env()
    try:
        service = load_factory_operation_service(
            client,
            candidate_directory=Path(candidate_directory_value),
            operation_root=operation_root,
            schema_directory=schema_directory,
            compose_project=os.environ.get("REPOFIXLAB_COMPOSE_PROJECT", "repofixlab"),
        )
    except Exception:
        try:
            client.close()
        finally:
            raise
    return service, client


def _load_runtime_from_environment(
    client: object,
    factory: FactoryOperationService,
) -> RuntimeOperationService | None:
    """Build the Docker runtime from frozen locks, evaluator kernel, and journal."""

    task_lock_value = os.environ.get(
        "REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_PATH"
    )
    task_lock_root_value = os.environ.get("REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_ROOT")
    if not task_lock_value and not task_lock_root_value:
        return None
    dataset_lock_value = os.environ.get("REPOFIXLAB_RUNTIME_DATASET_LOCK_PATH")
    kernel_sha256 = os.environ.get(
        "REPOFIXLAB_RUNTIME_EVALUATOR_KERNEL_SHA256"
    )
    if not kernel_sha256 or (not dataset_lock_value and not task_lock_root_value):
        raise RuntimeError("production runtime configuration is incomplete")
    schema_directory = Path(
        os.environ.get("REPOFIXLAB_SCHEMA_DIR", "/opt/repofixlab/schemas")
    )
    configuration = RuntimeDockerConfiguration(
        task_environment_lock_path=Path(task_lock_value or "/runtime-lock-required"),
        task_environment_lock_schema_path=(
            schema_directory / "task-environment-lock.schema.json"
        ),
        dataset_lock_path=Path(dataset_lock_value or "/dataset-lock-required"),
        dataset_lock_schema_path=schema_directory / "dataset-lock.schema.json",
        evaluator_kernel_root=Path(
            os.environ.get(
                "REPOFIXLAB_RUNTIME_EVALUATOR_KERNEL_ROOT",
                "/opt/repofixlab/evaluator-kernel/repofixlab_evaluator",
            )
        ),
        evaluator_kernel_sha256=kernel_sha256,
        runtime_lock_root=Path(task_lock_root_value) if task_lock_root_value else None,
    )
    backend = DockerRuntimeBackend(client, factory.catalog, configuration)
    operation_root = Path(
        os.environ.get(
            "REPOFIXLAB_RUNTIME_OPERATION_ROOT",
            "/var/lib/repofix/controller/runtime-operations",
        )
    )
    return RuntimeOperationService(
        backend,
        RuntimeOperationJournal(operation_root),
    )


def _runtime_enabled_from_environment() -> bool:
    """Parse the exact boolean switch controlling production runtime startup."""

    value = os.environ.get("REPOFIXLAB_RUNTIME_ENABLED", "true")
    if value not in {"true", "false"}:
        raise RuntimeError("REPOFIXLAB_RUNTIME_ENABLED must be exactly true or false")
    return value == "true"


def create_app(
    *,
    factory_service: FactoryOperationService | None = None,
    runtime_service: RuntimeOperationService | None = None,
    m3_image_resolution_service: M3ImageResolutionService | None = None,
    m3_preflight_service: M3PreflightService | None = None,
    load_factory_from_environment: bool = True,
) -> FastAPI:
    """Create the Controller API and bind injected or production-owned services."""

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        """Open privileged services at startup and close only resources owned here."""

        service = factory_service
        active_runtime_service = runtime_service
        active_m3_image_resolution_service = m3_image_resolution_service
        active_m3_preflight_service = m3_preflight_service
        owned_client: object | None = None
        try:
            if service is None and load_factory_from_environment:
                service, owned_client = _load_factory_from_environment()
            runtime_requested = _runtime_enabled_from_environment() and bool(
                os.environ.get("REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_PATH")
                or os.environ.get("REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_ROOT")
            )
            if (
                active_runtime_service is None
                and load_factory_from_environment
                and runtime_requested
            ):
                if service is None:
                    raise RuntimeError(
                        "production runtime requires the trusted candidate catalog"
                    )
                if owned_client is None:
                    owned_client = docker.from_env()
                active_runtime_service = _load_runtime_from_environment(
                    owned_client,
                    service,
                )
            if (
                active_m3_image_resolution_service is None
                and load_factory_from_environment
                and owned_client is not None
            ):
                active_m3_image_resolution_service = M3ImageResolutionService(
                    owned_client,
                    Path(
                        os.environ.get(
                            "REPOFIXLAB_M3_IMAGE_RESOLUTION_ROOT",
                            "/var/lib/repofix/controller/m3-image-resolutions",
                        )
                    ),
                )
            if active_m3_preflight_service is None and load_factory_from_environment and owned_client is not None:
                active_m3_preflight_service = M3PreflightService(
                    owned_client,
                    Path(os.environ.get("REPOFIXLAB_M3_PREFLIGHT_ROOT", "/var/lib/repofix/controller/m3-preflights")),
                    os.environ.get("REPOFIXLAB_M3_PRIVATE_VOLUME", "dataset-private-unconfigured"),
                )
        except Exception:
            if factory_service is None and service is not None:
                service.close()
            close = getattr(owned_client, "close", None)
            if callable(close):
                close()
            raise
        application.state.factory_service = service
        application.state.runtime_service = active_runtime_service
        application.state.m3_image_resolution_service = active_m3_image_resolution_service
        application.state.m3_preflight_service = active_m3_preflight_service
        try:
            yield
        finally:
            if runtime_service is None and active_runtime_service is not None:
                active_runtime_service.close()
            if factory_service is None and service is not None:
                service.close()
            close = getattr(owned_client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass

    application = FastAPI(
        title="RepoFixLab Trusted Harness Controller",
        version="0.1.0",
        lifespan=lifespan,
    )

    @application.get("/healthz")
    def healthz() -> dict[str, str]:
        """Return process liveness without claiming Docker runtime readiness."""

        return {"status": "ok"}

    @application.post("/v1/doctor/bootstrap")
    def bootstrap_doctor() -> dict[str, object]:
        """Collect one serialized, schema-validated bootstrap health report."""

        with BOOTSTRAP_DOCTOR_LOCK:
            return _bootstrap_doctor_locked()

    @application.post("/v1/factory/task-role-probes")
    def task_role_factory_probe(
        request: TaskRoleFactoryOperationRequest,
    ) -> JSONResponse:
        """Execute one idempotent probe from the trusted candidate catalog."""

        service = getattr(application.state, "factory_service", None)
        if not isinstance(service, FactoryOperationService):
            raise HTTPException(status_code=503, detail="factory service is unavailable")
        operation_request = FactoryHttpRequest(
            operation_id=request.operation_id,
            candidate_id=request.candidate_id,
            instance_id=request.instance_id,
        )
        try:
            result = service.execute(operation_request)
        except FactoryOperationConflict:
            raise HTTPException(
                status_code=409,
                detail="operation_id conflicts with an existing request",
            ) from None
        except FactoryCapacityBusy:
            raise HTTPException(status_code=429, detail="factory capacity is busy") from None
        except FactoryOperationRejected:
            raise HTTPException(status_code=404, detail="trusted candidate was not found") from None
        except FactoryServiceUnavailable:
            raise HTTPException(status_code=503, detail="factory service is unavailable") from None
        except Exception:
            raise HTTPException(status_code=500, detail="factory operation failed") from None
        return JSONResponse(
            content=result.report,
            headers={
                "X-RepoFixLab-Idempotent-Replay": (
                    "true" if result.replayed else "false"
                )
            },
        )

    @application.post("/v1/m3/official-images")
    def resolve_m3_official_images(
        request: M3OfficialImageResolutionRequest,
    ) -> JSONResponse:
        """Start or replay official-image resolution for the frozen M3 cohort."""

        service = getattr(application.state, "m3_image_resolution_service", None)
        if not isinstance(service, M3ImageResolutionService):
            raise HTTPException(status_code=503, detail="M3 image resolution service is unavailable")
        try:
            record, replayed = service.start(
                M3ImageResolutionRequest(
                    operation_id=request.operation_id,
                    dataset_revision=request.dataset_revision,
                    instance_ids=tuple(request.instance_ids),
                )
            )
        except M3ImageResolutionConflict:
            raise HTTPException(status_code=409, detail="M3 image resolution operation conflicts with state") from None
        except M3ImageResolutionError:
            raise HTTPException(status_code=422, detail="M3 image resolution was rejected") from None
        except Exception:
            raise HTTPException(status_code=500, detail="M3 image resolution failed") from None
        return JSONResponse(
            status_code=202 if record.get("status") == "running" else 200,
            content=record,
            headers={"X-RepoFixLab-Idempotent-Replay": "true" if replayed else "false"},
        )

    @application.post("/v1/m3/official-preflight")
    def preflight_m3_official_images(request: M3OfficialPreflightRequest) -> JSONResponse:
        """Start or replay the task, image, commit, and private-data preflight."""

        service = getattr(application.state, "m3_preflight_service", None)
        if not isinstance(service, M3PreflightService):
            raise HTTPException(status_code=503, detail="M3 preflight service is unavailable")
        try:
            record, replayed = service.start(
                M3PreflightRequest(
                    operation_id=request.operation_id,
                    dataset_revision=request.dataset_revision,
                    private_volume=request.private_volume,
                    tasks=tuple(
                        M3PreflightTask(
                            instance_id=task.instance_id,
                            base_commit=task.base_commit,
                            repo=task.repo,
                            private_task_sha256=task.private_task_sha256,
                            source_image_id=task.source_image_id,
                            adapted_image_reference=task.adapted_image_reference,
                            adapted_image_id=task.adapted_image_id,
                        )
                        for task in request.tasks
                    ),
                )
            )
        except M3PreflightConflict:
            raise HTTPException(status_code=409, detail="M3 preflight operation conflicts with state") from None
        except M3PreflightError:
            raise HTTPException(status_code=422, detail="M3 preflight was rejected") from None
        except Exception:
            raise HTTPException(status_code=500, detail="M3 preflight failed") from None
        return JSONResponse(
            status_code=202 if record.get("status") == "running" else 200,
            content=record,
            headers={"X-RepoFixLab-Idempotent-Replay": "true" if replayed else "false"},
        )

    install_runtime_routes(application)

    return application


app = create_app()


def _bootstrap_doctor_locked() -> dict[str, object]:
    """Collect fail-closed Docker bootstrap evidence under the process lock."""

    compose_project = os.environ.get("REPOFIXLAB_COMPOSE_PROJECT", "repofixlab")
    try:
        client = docker.from_env()
    except Exception as error:  # Return fail-closed machine evidence even when client creation fails.
        payload = unreachable_bootstrap_health(error).to_dict()
        BOOTSTRAP_HEALTH_VALIDATOR.validate(payload)
        return payload
    try:
        payload = collect_bootstrap_health(
            client,
            compose_project=compose_project,
        ).to_dict()
        BOOTSTRAP_HEALTH_VALIDATOR.validate(payload)
        return payload
    finally:
        try:
            client.close()
        except Exception:
            # Closing the local SDK transport must not replace collected machine evidence with HTML 500.
            pass
