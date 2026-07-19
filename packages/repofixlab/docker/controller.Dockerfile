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
COPY schemas/v1 ./schemas

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "repofixlab_controller.app:app", "--host", "0.0.0.0", "--port", "8000"]
