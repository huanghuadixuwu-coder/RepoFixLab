FROM swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8

ARG REPOFIXLAB_SANITIZER_SHA256
ARG REPOFIXLAB_ROLE_PROBE_SHA256
ARG REPOFIXLAB_WORKER_DOCKERFILE_SHA256
ARG REPOFIXLAB_WORKER_AUDIT_SHA256
ARG REPOFIXLAB_IMAGE_PROVENANCE_SHA256

COPY task-images/axios-5892/sanitize-git-history.sh /opt/repofixlab/sanitize-git-history.sh
COPY task-images/axios-5892/role-probe.mjs /opt/repofixlab/role-probe.mjs
COPY task-images/axios-5892/worker-sanitized.Dockerfile /opt/repofixlab/worker-sanitized.Dockerfile
COPY task-images/axios-5892/audit-worker-image.sh /opt/repofixlab/audit-worker-image.sh

RUN set -eux; \
	case "$REPOFIXLAB_SANITIZER_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	case "$REPOFIXLAB_ROLE_PROBE_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	case "$REPOFIXLAB_WORKER_DOCKERFILE_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	case "$REPOFIXLAB_WORKER_AUDIT_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	case "$REPOFIXLAB_IMAGE_PROVENANCE_SHA256" in *[!0-9a-f]*|'') exit 1 ;; esac; \
	test "${#REPOFIXLAB_SANITIZER_SHA256}" -eq 64; \
	test "${#REPOFIXLAB_ROLE_PROBE_SHA256}" -eq 64; \
	test "${#REPOFIXLAB_WORKER_DOCKERFILE_SHA256}" -eq 64; \
	test "${#REPOFIXLAB_WORKER_AUDIT_SHA256}" -eq 64; \
	test "${#REPOFIXLAB_IMAGE_PROVENANCE_SHA256}" -eq 64; \
	test "$(sha256sum /opt/repofixlab/sanitize-git-history.sh | cut -d ' ' -f 1)" = "$REPOFIXLAB_SANITIZER_SHA256"; \
	test "$(sha256sum /opt/repofixlab/role-probe.mjs | cut -d ' ' -f 1)" = "$REPOFIXLAB_ROLE_PROBE_SHA256"; \
	test "$(sha256sum /opt/repofixlab/worker-sanitized.Dockerfile | cut -d ' ' -f 1)" = "$REPOFIXLAB_WORKER_DOCKERFILE_SHA256"; \
	test "$(sha256sum /opt/repofixlab/audit-worker-image.sh | cut -d ' ' -f 1)" = "$REPOFIXLAB_WORKER_AUDIT_SHA256"; \
	chmod 0555 /opt/repofixlab/sanitize-git-history.sh /opt/repofixlab/role-probe.mjs /opt/repofixlab/audit-worker-image.sh; \
	chmod 0444 /opt/repofixlab/worker-sanitized.Dockerfile; \
	/opt/repofixlab/sanitize-git-history.sh /testbed ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b; \
	temporary_root="$(mktemp -d /tmp/repofixlab-worker-history.XXXXXX)"; \
	git clone --no-local --no-tags --single-branch --depth=1 --branch repofixlab-base file:///testbed "$temporary_root/repository"; \
	test "$(cat "$temporary_root/repository/.git/shallow")" = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"; \
	rm -rf -- /testbed/.git; \
	cp -a -- "$temporary_root/repository/.git" /testbed/.git; \
	rm -rf -- "$temporary_root"; \
	git -C /testbed remote remove origin; \
	rm -rf -- /testbed/.git/refs/remotes; \
	git -C /testbed for-each-ref --format='delete %(refname)' | git -C /testbed update-ref --stdin; \
	git -C /testbed update-ref refs/heads/repofixlab-base ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b; \
	git -C /testbed symbolic-ref HEAD refs/heads/repofixlab-base; \
	git -C /testbed config core.logAllRefUpdates false; \
	git -C /testbed reflog expire --expire=now --expire-unreachable=now --all; \
	rm -rf -- /testbed/.git/logs; \
	git -C /testbed repack -Ad; \
	git -C /testbed prune-packed; \
	git -C /testbed prune --expire=now; \
	git -C /testbed gc --prune=now --aggressive; \
	test "$(git -C /testbed rev-parse HEAD)" = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"; \
	test "$(git -C /testbed rev-parse 'HEAD^{tree}')" = "d37c27531ee7d744f25932ad0cb20ecabbf202ff"; \
	test "$(git -C /testbed for-each-ref --format='%(refname)')" = "refs/heads/repofixlab-base"; \
	test "$(git -C /testbed rev-list --all)" = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"; \
	test "$(cat /testbed/.git/shallow)" = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"; \
	! git -C /testbed rev-parse --verify 'HEAD^'; \
	! git -C /testbed cat-file -e a989ccdc1a672171e9b45d3f02edc260109a607c^{commit}; \
	test -z "$(git -C /testbed remote)"; \
	test -z "$(git -C /testbed reflog show --all)"; \
	test -z "$(git -C /testbed status --porcelain=v1)"; \
	test -z "$(git -C /testbed log --all --format='%H%x09%s%x09%b' --grep='5892')"; \
	test -z "$(git -C /testbed fsck --full --strict --no-reflogs 2>&1)"; \
	test -z "$(git -C /testbed fsck --full --unreachable --no-reflogs 2>&1)"; \
	git config --system --add safe.directory /testbed

ENV HOME=/tmp/repofixlab-home

LABEL io.repofixlab.instance-id="axios__axios-5892" \
	io.repofixlab.role="worker" \
	io.repofixlab.base-commit="ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b" \
	io.repofixlab.worker-history-profile="exact-base-shallow-single-commit-v1" \
	io.repofixlab.source-repository-digest="swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8" \
	io.repofixlab.sanitizer-sha256="${REPOFIXLAB_SANITIZER_SHA256}" \
	io.repofixlab.role-probe-sha256="${REPOFIXLAB_ROLE_PROBE_SHA256}" \
	io.repofixlab.worker-dockerfile-sha256="${REPOFIXLAB_WORKER_DOCKERFILE_SHA256}" \
	io.repofixlab.worker-audit-sha256="${REPOFIXLAB_WORKER_AUDIT_SHA256}" \
	io.repofixlab.provenance-sha256="${REPOFIXLAB_IMAGE_PROVENANCE_SHA256}"
