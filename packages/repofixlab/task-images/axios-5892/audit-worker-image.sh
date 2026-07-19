#!/bin/bash
set -euo pipefail

readonly expected_repository="/testbed"
readonly expected_base_commit="ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"
readonly expected_parent_commit="a989ccdc1a672171e9b45d3f02edc260109a607c"
readonly expected_tree="d37c27531ee7d744f25932ad0cb20ecabbf202ff"

if [[ "$#" -ne 1 || "$1" != "$expected_repository" ]]; then
	echo "usage: audit-worker-image.sh /testbed" >&2
	exit 2
fi

git_in_repository() {
	git -c "safe.directory=$expected_repository" -C "$expected_repository" "$@"
}

readonly observed_head="$(git_in_repository rev-parse HEAD)"
readonly observed_tree="$(git_in_repository rev-parse 'HEAD^{tree}')"
readonly observed_refs="$(git_in_repository for-each-ref --format='%(refname)')"
readonly observed_commits="$(git_in_repository rev-list --all)"
readonly observed_shallow_boundary="$(cat "$expected_repository/.git/shallow")"

[[ "$observed_head" == "$expected_base_commit" ]]
[[ "$observed_tree" == "$expected_tree" ]]
[[ "$observed_refs" == "refs/heads/repofixlab-base" ]]
[[ "$observed_commits" == "$expected_base_commit" ]]
[[ "$observed_shallow_boundary" == "$expected_base_commit" ]]

if git_in_repository rev-parse --verify 'HEAD^' >/dev/null 2>&1; then
	echo "worker repository unexpectedly resolves HEAD^" >&2
	exit 1
fi
if git_in_repository cat-file -e "$expected_parent_commit^{commit}" >/dev/null 2>&1; then
	echo "worker repository still contains the base parent commit" >&2
	exit 1
fi
if [[ -n "$(git_in_repository remote)" ]]; then
	echo "worker repository contains a Git remote" >&2
	exit 1
fi
if [[ -n "$(git_in_repository reflog show --all)" ]]; then
	echo "worker repository contains a reflog entry" >&2
	exit 1
fi
if [[ -n "$(git_in_repository status --porcelain=v1)" ]]; then
	echo "worker repository worktree is not clean" >&2
	exit 1
fi
if [[ -n "$(git_in_repository log --all --format='%H%x09%s%x09%b' --grep='5892')" ]]; then
	echo "worker repository exposes an issue 5892 commit" >&2
	exit 1
fi
if [[ -n "$(git_in_repository fsck --full --strict --no-reflogs 2>&1)" ]]; then
	echo "worker repository failed strict Git object validation" >&2
	exit 1
fi
if [[ -n "$(git_in_repository fsck --full --unreachable --no-reflogs 2>&1)" ]]; then
	echo "worker repository contains unreachable Git objects" >&2
	exit 1
fi

printf '%s\n' \
	"head=$observed_head" \
	"tree=$observed_tree" \
	"refs=1" \
	"reachable_commits=1" \
	"shallow_boundary=$observed_shallow_boundary" \
	"base_parent_present=false" \
	"remote_count=0" \
	"reflog_entries=0" \
	"unreachable_objects=0" \
	"status=pass"
