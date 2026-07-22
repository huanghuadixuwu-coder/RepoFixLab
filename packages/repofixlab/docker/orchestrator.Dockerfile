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

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts
# The pi-ai npm build refreshes model catalogs from the network. Compile the
# repository-locked generated sources directly for a deterministic offline image.
RUN --network=none npm --prefix packages/tui run build \
	&& ./node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json \
	&& npm --prefix packages/agent run build \
	&& npm --prefix packages/coding-agent run build \
	&& npm --prefix packages/repofixlab run build
RUN --network=none node --check packages/repofixlab/docker/public-volume-permissions.mjs \
	&& node --check packages/repofixlab/docker/private-volume-permissions.mjs \
	&& node --check packages/repofixlab/docker/m6-p0-readiness.mjs \
	&& node --check packages/repofixlab/docker/m8-analysis.mjs \
	&& node --check packages/repofixlab/docker/m9-run.mjs \
	&& node --check packages/repofixlab/docker/m9-analysis.mjs \
	&& node packages/repofixlab/docker/orchestrator-module-smoke.mjs

ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "packages/repofixlab/dist/cli/main.js"]
