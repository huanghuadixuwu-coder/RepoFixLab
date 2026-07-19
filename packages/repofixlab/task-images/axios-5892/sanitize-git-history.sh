#!/bin/bash
set -euo pipefail

readonly expected_repository="/testbed"
readonly expected_base_commit="ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"

if [[ "$#" -ne 2 || "$1" != "$expected_repository" || "$2" != "$expected_base_commit" ]]; then
	echo "usage: sanitize-git-history.sh /testbed $expected_base_commit" >&2
	exit 2
fi

cd -- "$expected_repository"

if [[ "$(git rev-parse HEAD)" != "$expected_base_commit" ]]; then
	echo "source image HEAD does not match the locked Axios base commit" >&2
	exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
	echo "source image worktree is not clean" >&2
	exit 1
fi

git checkout --detach "$expected_base_commit"
git for-each-ref --format='delete %(refname)' | git update-ref --stdin
git update-ref refs/heads/repofixlab-base "$expected_base_commit"
git reflog expire --expire=now --expire-unreachable=now --all
git repack -Ad
git prune-packed
git prune --expire=now
git gc --prune=now --aggressive

readonly remaining_refs="$(git for-each-ref --format='%(refname)')"
if [[ "$remaining_refs" != "refs/heads/repofixlab-base" ]]; then
	echo "sanitized repository contains unexpected refs" >&2
	exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$expected_base_commit" ]]; then
	echo "sanitized repository HEAD drifted" >&2
	exit 1
fi
if [[ -n "$(git rev-list HEAD.. --all)" ]]; then
	echo "sanitized repository still exposes commits outside base ancestry" >&2
	exit 1
fi
if [[ -n "$(git fsck --full --unreachable --no-reflogs 2>/dev/null)" ]]; then
	echo "sanitized repository still contains unreachable Git objects" >&2
	exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
	echo "sanitized repository worktree is not clean" >&2
	exit 1
fi

git config --system --add safe.directory "$expected_repository"
