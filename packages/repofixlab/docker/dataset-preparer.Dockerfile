FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY dataset-preparer/requirements.lock /tmp/requirements.lock
RUN python -m pip install \
        --disable-pip-version-check \
        --no-cache-dir \
        --no-deps \
        --only-binary=:all: \
        --require-hashes \
        --root-user-action=ignore \
        --requirement /tmp/requirements.lock \
    && python -c "import pyarrow; assert pyarrow.__version__ == '25.0.0'" \
    && rm /tmp/requirements.lock

COPY --chown=65532:65532 dataset-preparer/repofix_dataset_preparer /app/repofix_dataset_preparer
RUN rm -rf /app/repofix_dataset_preparer/__pycache__ \
    && install -d -o 65532 -g 65532 /data/public /data/control /data/private /input

USER 65532:65532

ENTRYPOINT ["python", "-m", "repofix_dataset_preparer"]
