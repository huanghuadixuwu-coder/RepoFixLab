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
from .container_factory import AXIOS_SMOKE_INSTANCE_ID
from .factory_service import (
    FactoryCapacityBusy,
    FactoryHttpRequest,
    FactoryOperationConflict,
    FactoryOperationRejected,
    FactoryOperationService,
    FactoryServiceUnavailable,
    load_factory_operation_service,
)
from .runtime_http import install_runtime_routes
from .runtime_docker import (
    DockerRuntimeBackend,
    RuntimeDockerConfiguration,
)
from .runtime_journal import RuntimeOperationJournal
from .runtime_service import RuntimeOperationService


def _bootstrap_health_validator() -> Draft202012Validator:
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
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    operation_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$",
    )
    candidate_id: str = Field(min_length=1, max_length=160)
    instance_id: Literal[AXIOS_SMOKE_INSTANCE_ID]


def _load_factory_from_environment() -> tuple[FactoryOperationService | None, object | None]:
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
    task_lock_value = os.environ.get(
        "REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_PATH"
    )
    if not task_lock_value:
        return None
    dataset_lock_value = os.environ.get("REPOFIXLAB_RUNTIME_DATASET_LOCK_PATH")
    kernel_sha256 = os.environ.get(
        "REPOFIXLAB_RUNTIME_EVALUATOR_KERNEL_SHA256"
    )
    if not dataset_lock_value or not kernel_sha256:
        raise RuntimeError("production runtime configuration is incomplete")
    schema_directory = Path(
        os.environ.get("REPOFIXLAB_SCHEMA_DIR", "/opt/repofixlab/schemas")
    )
    configuration = RuntimeDockerConfiguration(
        task_environment_lock_path=Path(task_lock_value),
        task_environment_lock_schema_path=(
            schema_directory / "task-environment-lock.schema.json"
        ),
        dataset_lock_path=Path(dataset_lock_value),
        dataset_lock_schema_path=schema_directory / "dataset-lock.schema.json",
        evaluator_kernel_root=Path(
            os.environ.get(
                "REPOFIXLAB_RUNTIME_EVALUATOR_KERNEL_ROOT",
                "/opt/repofixlab/evaluator-kernel/repofixlab_evaluator",
            )
        ),
        evaluator_kernel_sha256=kernel_sha256,
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


def create_app(
    *,
    factory_service: FactoryOperationService | None = None,
    runtime_service: RuntimeOperationService | None = None,
    load_factory_from_environment: bool = True,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        service = factory_service
        active_runtime_service = runtime_service
        owned_client: object | None = None
        try:
            if service is None and load_factory_from_environment:
                service, owned_client = _load_factory_from_environment()
            runtime_requested = bool(
                os.environ.get("REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_PATH")
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
        except Exception:
            if factory_service is None and service is not None:
                service.close()
            close = getattr(owned_client, "close", None)
            if callable(close):
                close()
            raise
        application.state.factory_service = service
        application.state.runtime_service = active_runtime_service
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
        return {"status": "ok"}

    @application.post("/v1/doctor/bootstrap")
    def bootstrap_doctor() -> dict[str, object]:
        with BOOTSTRAP_DOCTOR_LOCK:
            return _bootstrap_doctor_locked()

    @application.post("/v1/factory/task-role-probes")
    def task_role_factory_probe(
        request: TaskRoleFactoryOperationRequest,
    ) -> JSONResponse:
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

    install_runtime_routes(application)

    return application


app = create_app()


def _bootstrap_doctor_locked() -> dict[str, object]:
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
