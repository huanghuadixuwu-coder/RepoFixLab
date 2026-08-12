# 脚本职责：构建绑定 Compose 身份和冻结运行资产的受信 Controller 镜像。
# 输入边界：接收规范配置哈希并复制仓库内已审查的运行资产。
# 输出边界：生成只暴露受限 HTTP 接口的确定性 Controller 镜像。
FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d

ARG REPOFIXLAB_COMPOSE_CONFIG_SHA256
RUN if [ "${#REPOFIXLAB_COMPOSE_CONFIG_SHA256}" -ne 64 ]; then \
        echo "REPOFIXLAB_COMPOSE_CONFIG_SHA256 must be exactly 64 lowercase hexadecimal characters" >&2; \
        exit 1; \
    fi; \
    case "$REPOFIXLAB_COMPOSE_CONFIG_SHA256" in \
        *[!0-9a-f]*) \
            echo "REPOFIXLAB_COMPOSE_CONFIG_SHA256 must be exactly 64 lowercase hexadecimal characters" >&2; \
            exit 1 \
            ;; \
    esac
LABEL io.repofixlab.compose-config-sha256="${REPOFIXLAB_COMPOSE_CONFIG_SHA256}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    REPOFIXLAB_SCHEMA_PATH=/opt/repofixlab/schemas/controller-bootstrap-health.schema.json \
    REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_PATH=/opt/repofixlab/runtime-locks/m6-26-task-v1/axios-4731/task-environment-lock.json \
    REPOFIXLAB_RUNTIME_TASK_ENVIRONMENT_LOCK_ROOT=/opt/repofixlab/runtime-locks/m6-26-task-v1 \
    REPOFIXLAB_RUNTIME_DATASET_LOCK_PATH=/opt/repofixlab/runtime-locks/m6-26-task-v1/dataset-lock.json \
    REPOFIXLAB_RUNTIME_EVALUATOR_KERNEL_ROOT=/opt/repofixlab/evaluator-kernel/repofixlab_evaluator \
    REPOFIXLAB_RUNTIME_EVALUATOR_KERNEL_SHA256=2383940496a01fbf7dcd36de1d7774e3a6e9a8a753f3ffa4b18260e4d8bc8517 \
    PYTHONPATH=/opt/repofixlab/src

WORKDIR /opt/repofixlab

COPY controller/requirements.txt ./requirements.txt
RUN python -m pip install \
        --disable-pip-version-check \
        --no-cache-dir \
        --no-compile \
        --no-deps \
        --only-binary=:all: \
        --require-hashes \
        --requirement requirements.txt \
    && python -m pip check

COPY controller/src ./src
RUN python -m py_compile src/repofixlab_controller/m6_runtime_preflight_client.py
COPY evaluator/repofixlab_evaluator ./evaluator-kernel/repofixlab_evaluator
COPY configs/runtime/axios-5892 ./runtime-locks/axios-5892
COPY configs/runtime/m6-26-task-v1 ./runtime-locks/m6-26-task-v1
COPY configs/runtime/axios-5892/dataset-lock.json ./runtime-locks/m6-26-task-v1/dataset-lock.json
COPY schemas/v1 ./schemas

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "repofixlab_controller.app:app", "--host", "0.0.0.0", "--port", "8000"]
