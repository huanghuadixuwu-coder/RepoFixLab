#!/bin/bash
set -euo pipefail

readonly repository="/testbed"

if [[ "$#" -ne 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
	echo "usage: sanitize-git-history.sh <base-commit>" >&2
	exit 2
fi

readonly base_commit="$1"

if [[ ! -d "$repository/.git" ]]; then
	echo "official task image does not expose a Git checkout" >&2
	exit 1
fi

git_in_repository() {
	git -c "safe.directory=$repository" -C "$repository" "$@"
}

git_in_repository cat-file -e "${base_commit}^{commit}"
git_in_repository checkout --detach "$base_commit"
git_in_repository reset --hard "$base_commit"
git_in_repository clean -fd

temporary_root="$(mktemp -d /tmp/repofixlab-history.XXXXXX)"
trap 'rm -rf -- "$temporary_root"' EXIT

# Build an exact one-commit repository locally. `git clone file://...` is
# rejected under the image build's `--network=none` policy, so transfer only
# the sealed base commit, its root tree, and its recursively reachable tree
# objects through Git's object database instead of opening any transport.
git init --quiet "$temporary_root/repository"
{
	printf '%s\n' "$base_commit"
	git_in_repository rev-parse "${base_commit}^{tree}"
	git_in_repository ls-tree -r -t "$base_commit" | awk '$2 == "blob" || $2 == "tree" { print $3 }'
} | sort -u | git_in_repository pack-objects --stdout > "$temporary_root/base.pack"
git -C "$temporary_root/repository" index-pack --stdin --fix-thin --keep=repofixlab-base < "$temporary_root/base.pack"
printf '%s\n' "$base_commit" > "$temporary_root/repository/.git/shallow"
git -C "$temporary_root/repository" update-ref refs/heads/repofixlab-base "$base_commit"
git -C "$temporary_root/repository" symbolic-ref HEAD refs/heads/repofixlab-base

# The one-commit repository preserves the exact upstream base commit and
# worktree tree, but keeps none of its parents, abandoned objects, remotes, or
# reflogs. This replaces `git gc --aggressive`, whose cost grows with the
# original project history and made the reproducible 26-task image build
# impractically slow.
rm -rf -- "$repository/.git"
cp -a -- "$temporary_root/repository/.git" "$repository/.git"
rm -rf -- "$repository/.git/refs/remotes" "$repository/.git/logs"
git_in_repository config core.logAllRefUpdates false
git_in_repository reset --mixed "$base_commit"
git_in_repository reflog expire --expire=now --expire-unreachable=now --all
git_in_repository repack -Ad
git_in_repository prune-packed
git_in_repository prune --expire=now

[[ "$(git_in_repository rev-parse HEAD)" == "$base_commit" ]]
[[ "$(git_in_repository for-each-ref --format='%(refname)')" == "refs/heads/repofixlab-base" ]]
[[ "$(git_in_repository rev-list --all)" == "$base_commit" ]]
[[ "$(cat "$repository/.git/shallow")" == "$base_commit" ]]
! git_in_repository rev-parse --verify 'HEAD^' >/dev/null 2>&1
[[ -z "$(git_in_repository remote)" ]]
[[ -z "$(git_in_repository reflog show --all)" ]]
[[ -z "$(git_in_repository fsck --full --unreachable --no-reflogs 2>&1)" ]]
[[ -z "$(git_in_repository status --porcelain=v1)" ]]

git config --system --add safe.directory "$repository"
