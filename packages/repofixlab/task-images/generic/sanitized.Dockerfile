ARG SOURCE_IMAGE=repofixlab/invalid-source:never
FROM ${SOURCE_IMAGE}

ARG INSTANCE_ID
ARG BASE_COMMIT
ARG SOURCE_REPOSITORY_DIGEST
ARG REPOFIXLAB_SANITIZER_SHA256
ARG REPOFIXLAB_ROLE_PROBE_SHA256
ARG REPOFIXLAB_IMAGE_PROVENANCE_SHA256

COPY task-images/generic/sanitize-git-history.sh /opt/repofixlab/sanitize-git-history.sh
COPY task-images/generic/role-probe.mjs /opt/repofixlab/role-probe.mjs

RUN set -eux; \
	case "$INSTANCE_ID" in *[!A-Za-z0-9_.-]*|'') exit 1 ;; esac; \
	case "$BASE_COMMIT" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	case "$SOURCE_REPOSITORY_DIGEST" in *[[:space:]]*|'') exit 1 ;; esac; \
	for value in "$REPOFIXLAB_SANITIZER_SHA256" "$REPOFIXLAB_ROLE_PROBE_SHA256" "$REPOFIXLAB_IMAGE_PROVENANCE_SHA256"; do case "$value" in *[!0-9a-f]*|'') exit 1 ;; esac; test "${#value}" -eq 64; done; \
	test "$(sha256sum /opt/repofixlab/sanitize-git-history.sh | cut -d ' ' -f 1)" = "$REPOFIXLAB_SANITIZER_SHA256"; \
	test "$(sha256sum /opt/repofixlab/role-probe.mjs | cut -d ' ' -f 1)" = "$REPOFIXLAB_ROLE_PROBE_SHA256"; \
	chmod 0555 /opt/repofixlab/sanitize-git-history.sh /opt/repofixlab/role-probe.mjs; \
	/opt/repofixlab/sanitize-git-history.sh "$BASE_COMMIT"

ENV HOME=/tmp/repofixlab-home

LABEL io.repofixlab.instance-id="${INSTANCE_ID}" \
	io.repofixlab.base-commit="${BASE_COMMIT}" \
	io.repofixlab.source-repository-digest="${SOURCE_REPOSITORY_DIGEST}" \
	io.repofixlab.sanitizer-sha256="${REPOFIXLAB_SANITIZER_SHA256}" \
	io.repofixlab.role-probe-sha256="${REPOFIXLAB_ROLE_PROBE_SHA256}" \
	io.repofixlab.provenance-sha256="${REPOFIXLAB_IMAGE_PROVENANCE_SHA256}"
