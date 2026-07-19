from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path, PurePosixPath

from .errors import (
    BaseStateError,
    PatchApplyError,
    PatchPolicyError,
    TestPatchApplyError,
    TestPatchConflictError,
    TestPatchPolicyError,
)
from .private_spec import MAX_PATCH_BYTES

_DIFF_HEADER = re.compile(r"^diff --git a/([^\s]+) b/([^\s]+)$")
_FILE_HEADER = re.compile(r"^(---|\+\+\+) (a/|b/)([^\s]+)(?:\t.*)?$")
_PATH_METADATA_HEADER = re.compile(r"^(?:rename|copy) (?:from|to) ([^\s]+)$")
_DENIED_PATCH_MODE = re.compile(r"^(?:old|new|deleted file|new file) mode (?:120000|160000)$")
_DENIED_INDEX_MODE = re.compile(r"^index [0-9a-f]+\.\.[0-9a-f]+ (?:120000|160000)$")
_DENIED_COMPONENTS = {".git", ".gitmodules", ".repofixlab", "node_modules"}


def _validate_relative_path(value: str) -> str:
    path = PurePosixPath(value)
    if not value or value.startswith("/") or "\\" in value or path.is_absolute():
        raise PatchPolicyError("patch path is not a relative POSIX path")
    if value != path.as_posix() or any(
        part in {"", ".", ".."} or part in _DENIED_COMPONENTS for part in path.parts
    ):
        raise PatchPolicyError("patch path contains a denied component")
    return path.as_posix()


def validate_patch(
    patch: bytes,
    workspace: Path,
    *,
    test_patch: bool,
    maximum_bytes: int = MAX_PATCH_BYTES,
) -> frozenset[str]:
    error_type = TestPatchPolicyError if test_patch else PatchPolicyError
    try:
        if not patch or len(patch) > maximum_bytes or b"\x00" in patch:
            raise PatchPolicyError("patch violates size or content policy")
        text = patch.decode("utf-8")
        paths: set[str] = set()
        diff_count = 0
        for line in text.splitlines():
            match = _DIFF_HEADER.match(line)
            if match is not None:
                diff_count += 1
                paths.add(_validate_relative_path(match.group(1)))
                paths.add(_validate_relative_path(match.group(2)))
                continue
            header = _FILE_HEADER.match(line)
            if header is not None:
                if (header.group(1), header.group(2)) not in {("---", "a/"), ("+++", "b/")}:
                    raise PatchPolicyError("patch contains a non-canonical file header")
                paths.add(_validate_relative_path(header.group(3)))
            elif line.startswith(("--- ", "+++ ")) and line not in {"--- /dev/null", "+++ /dev/null"}:
                raise PatchPolicyError("patch contains a non-canonical file header")
            metadata_header = _PATH_METADATA_HEADER.match(line)
            if metadata_header is not None:
                paths.add(_validate_relative_path(metadata_header.group(1)))
            if _DENIED_PATCH_MODE.match(line) is not None or _DENIED_INDEX_MODE.match(line) is not None:
                raise PatchPolicyError("symlink and submodule patch modes are denied")
        if diff_count == 0 or not paths:
            raise PatchPolicyError("patch has no strict git diff headers")
        root = workspace.resolve(strict=True)
        for relative in paths:
            current = root
            for component in PurePosixPath(relative).parts:
                current = current / component
                if current.exists() or current.is_symlink():
                    mode = os.lstat(current).st_mode
                    if stat.S_ISLNK(mode):
                        raise PatchPolicyError("patch path traverses a symlink")
        return frozenset(paths)
    except PatchPolicyError as error:
        if test_patch:
            raise error_type(str(error)) from error
        raise


def reject_path_conflict(candidate_paths: frozenset[str], test_paths: frozenset[str]) -> None:
    if candidate_paths & test_paths:
        raise TestPatchConflictError("candidate and test patch paths overlap")


class GitRepository:
    def __init__(self, workspace: Path, base_commit: str) -> None:
        self.workspace = workspace
        self.base_commit = base_commit

    def _git(self, arguments: list[str], *, patch: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["git", *arguments],
            cwd=self.workspace,
            input=patch,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=60,
        )

    def reset_and_verify_base(self) -> None:
        if self.workspace.resolve() != Path("/testbed") and os.environ.get("REPOFIXLAB_TEST_MODE") != "1":
            raise BaseStateError("formal evaluator workspace must be /testbed")
        if not (self.workspace / ".git").is_dir():
            raise BaseStateError("evaluator workspace is not a Git repository")
        head = self._git(["rev-parse", "HEAD"])
        if head.returncode != 0 or head.stdout.decode("ascii", "replace").strip() != self.base_commit:
            raise BaseStateError("evaluator HEAD does not match the frozen base")
        # Preserve image-baked, ignored dependencies such as node_modules. The
        # Evaluator workspace is fresh, and patch policy forbids modifying them.
        for command in (["reset", "--hard", self.base_commit], ["clean", "-fd"]):
            result = self._git(list(command))
            if result.returncode != 0:
                raise BaseStateError("evaluator base reset failed")
        status_result = self._git(["status", "--porcelain=v1", "--untracked-files=all"])
        if status_result.returncode != 0 or status_result.stdout:
            raise BaseStateError("evaluator base is not clean after reset")

    def _apply(self, patch: bytes, *, test_patch: bool) -> None:
        error_type = TestPatchApplyError if test_patch else PatchApplyError
        for arguments in (
            ["apply", "--check", "--whitespace=nowarn", "--recount", "-"],
            ["apply", "--whitespace=nowarn", "--recount", "-"],
        ):
            result = self._git(arguments, patch=patch)
            if result.returncode != 0:
                raise error_type("git apply rejected the patch")

    def apply_candidate(self, patch: bytes) -> None:
        self._apply(patch, test_patch=False)

    def apply_test_patch(self, patch: bytes) -> None:
        self._apply(patch, test_patch=True)
