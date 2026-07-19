FROM swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8

ARG REPOFIXLAB_SANITIZER_SHA256
ARG REPOFIXLAB_ROLE_PROBE_SHA256
ARG REPOFIXLAB_IMAGE_PROVENANCE_SHA256

COPY task-images/axios-5892/sanitize-git-history.sh /opt/repofixlab/sanitize-git-history.sh
COPY task-images/axios-5892/role-probe.mjs /opt/repofixlab/role-probe.mjs

RUN set -eux; \
	case "$REPOFIXLAB_SANITIZER_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	case "$REPOFIXLAB_ROLE_PROBE_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	case "$REPOFIXLAB_IMAGE_PROVENANCE_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	test "${#REPOFIXLAB_SANITIZER_SHA256}" -eq 64; \
	test "${#REPOFIXLAB_ROLE_PROBE_SHA256}" -eq 64; \
	test "${#REPOFIXLAB_IMAGE_PROVENANCE_SHA256}" -eq 64; \
	test "$(sha256sum /opt/repofixlab/sanitize-git-history.sh | cut -d ' ' -f 1)" = "$REPOFIXLAB_SANITIZER_SHA256"; \
	test "$(sha256sum /opt/repofixlab/role-probe.mjs | cut -d ' ' -f 1)" = "$REPOFIXLAB_ROLE_PROBE_SHA256"; \
	chmod 0555 /opt/repofixlab/sanitize-git-history.sh /opt/repofixlab/role-probe.mjs; \
	/opt/repofixlab/sanitize-git-history.sh /testbed ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b

ENV HOME=/tmp/repofixlab-home

LABEL io.repofixlab.instance-id="axios__axios-5892" \
	io.repofixlab.base-commit="ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b" \
	io.repofixlab.source-repository-digest="swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8" \
	io.repofixlab.sanitizer-sha256="${REPOFIXLAB_SANITIZER_SHA256}" \
	io.repofixlab.role-probe-sha256="${REPOFIXLAB_ROLE_PROBE_SHA256}" \
	io.repofixlab.provenance-sha256="${REPOFIXLAB_IMAGE_PROVENANCE_SHA256}"
