#!/bin/bash
set -euo pipefail

readonly repository="/testbed"

if [[ "$#" -ne 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
	echo "usage: audit-worker-image.sh <base-commit>" >&2
	exit 2
fi

readonly base_commit="$1"

git_in_repository() {
	git -c "safe.directory=$repository" -C "$repository" "$@"
}

[[ "$(git_in_repository rev-parse HEAD)" == "$base_commit" ]]
[[ "$(git_in_repository for-each-ref --format='%(refname)')" == "refs/heads/repofixlab-base" ]]
[[ "$(git_in_repository rev-list --all)" == "$base_commit" ]]
[[ "$(cat "$repository/.git/shallow")" == "$base_commit" ]]

if git_in_repository rev-parse --verify 'HEAD^' >/dev/null 2>&1; then
	echo "worker repository unexpectedly resolves the base parent" >&2
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
if [[ -n "$(git_in_repository fsck --full --strict --no-reflogs 2>&1)" ]]; then
	echo "worker repository failed strict Git object validation" >&2
	exit 1
fi
if [[ -n "$(git_in_repository fsck --full --unreachable --no-reflogs 2>&1)" ]]; then
	echo "worker repository contains unreachable Git objects" >&2
	exit 1
fi

printf '%s\n' \
	"head=$base_commit" \
	"refs=1" \
	"reachable_commits=1" \
	"shallow_boundary=$base_commit" \
	"base_parent_present=false" \
	"remote_count=0" \
	"reflog_entries=0" \
	"unreachable_objects=0" \
	"status=pass"
