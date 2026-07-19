FROM mirror.gcr.io/library/node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

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

ENV NODE_ENV=development
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts

USER node
ENTRYPOINT ["node", "packages/repofixlab/src/cli/main.ts"]
