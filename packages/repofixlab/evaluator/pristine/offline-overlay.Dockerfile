FROM repofixlab/pristine-harness:m0-726c5461-orderfix

ARG PROVENANCE_SHA256

LABEL org.opencontainers.image.title="RepoFixLab pristine SWE-bench harness" \
      org.opencontainers.image.revision="726c5461e2ef52d83cf1ea2107870a8bb3328d57" \
      io.repofixlab.harness.mode="pristine" \
      io.repofixlab.provenance.sha256="${PROVENANCE_SHA256}"

ENV REPOFIXLAB_PROVENANCE_SHA256=${PROVENANCE_SHA256}

COPY requirements.lock /opt/locks/requirements.lock
COPY official-source-lock.json /opt/locks/official-source-lock.json
COPY upstream /opt/upstream
COPY repofixlab_evaluator /opt/repofixlab/repofixlab_evaluator
COPY build-provenance.json /opt/provenance/build-provenance.json

RUN --network=none python -m pip check \
    && python -m repofixlab_evaluator.pristine_runtime self-check

USER 65532:65532
ENTRYPOINT ["python", "-m", "repofixlab_evaluator.pristine_runtime"]
CMD ["self-check"]
