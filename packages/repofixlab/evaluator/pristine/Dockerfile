FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d

ARG PROVENANCE_SHA256

LABEL org.opencontainers.image.title="RepoFixLab pristine SWE-bench harness" \
      org.opencontainers.image.revision="726c5461e2ef52d83cf1ea2107870a8bb3328d57" \
      io.repofixlab.harness.mode="pristine" \
      io.repofixlab.provenance.sha256="${PROVENANCE_SHA256}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONPATH=/opt/repofixlab:/opt/upstream \
    REPOFIXLAB_PROVENANCE_SHA256=${PROVENANCE_SHA256}

COPY requirements.lock /opt/locks/requirements.lock
RUN python -m pip install \
        --disable-pip-version-check \
        --no-cache-dir \
        --require-hashes \
        --only-binary=:all: \
        --no-deps \
        --requirement /opt/locks/requirements.lock \
    && python -m pip check

COPY official-source-lock.json /opt/locks/official-source-lock.json
COPY upstream /opt/upstream
COPY repofixlab_evaluator /opt/repofixlab/repofixlab_evaluator
COPY build-provenance.json /opt/provenance/build-provenance.json

RUN --network=none python -m repofixlab_evaluator.pristine_runtime self-check

USER 65532:65532
ENTRYPOINT ["python", "-m", "repofixlab_evaluator.pristine_runtime"]
CMD ["self-check"]
