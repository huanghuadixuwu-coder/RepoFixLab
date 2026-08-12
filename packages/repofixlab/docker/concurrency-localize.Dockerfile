# 脚本职责：基于已验收编排镜像装配 WORKSTREAM7 定位运行时。
# 输入边界：接收锁定依赖、当前 RepoFixLab 源码和 Compose 配置哈希。
# 输出边界：生成含 PostgreSQL 驱动且直接执行 TypeScript 的本机验收镜像。

FROM mirror.gcr.io/library/node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS dependencies

ENV NODE_ENV=development
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/agent/package.json packages/agent/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/coding-agent/package.json packages/coding-agent/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/repofixlab/package.json packages/repofixlab/package.json
COPY packages/tui/package.json packages/tui/package.json
RUN npm ci --ignore-scripts

FROM repofixlab-orchestrator AS runtime

ARG REPOFIXLAB_COMPOSE_CONFIG_SHA256
USER root
RUN if [ "${#REPOFIXLAB_COMPOSE_CONFIG_SHA256}" -ne 64 ]; then \
		echo "REPOFIXLAB_COMPOSE_CONFIG_SHA256 must contain 64 lowercase hexadecimal characters" >&2; \
		exit 1; \
	fi; \
	case "$REPOFIXLAB_COMPOSE_CONFIG_SHA256" in \
		*[!0-9a-f]*) \
			echo "REPOFIXLAB_COMPOSE_CONFIG_SHA256 must contain 64 lowercase hexadecimal characters" >&2; \
			exit 1 \
			;; \
	esac
LABEL io.repofixlab.workstream7.compose-config-sha256="${REPOFIXLAB_COMPOSE_CONFIG_SHA256}"

COPY --from=dependencies --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --chown=node:node packages/repofixlab /workspace/packages/repofixlab

ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "packages/repofixlab/test/concurrency/workstream7-localize.ts"]
