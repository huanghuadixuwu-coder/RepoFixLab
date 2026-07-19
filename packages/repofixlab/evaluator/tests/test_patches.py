from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from repofixlab_evaluator.errors import PatchPolicyError, TestPatchConflictError, TestPatchPolicyError
from repofixlab_evaluator.patches import reject_path_conflict, validate_patch
from repofixlab_evaluator.private_spec import MAX_PATCH_BYTES


def patch_for(path: str) -> bytes:
    return (
        f"diff --git a/{path} b/{path}\n"
        f"--- a/{path}\n"
        f"+++ b/{path}\n"
        "@@ -1 +1 @@\n"
        "-before\n"
        "+after\n"
    ).encode()


class PatchPolicyTests(unittest.TestCase):
    def test_accepts_a_confined_git_patch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = validate_patch(patch_for("lib/http.js"), Path(directory), test_patch=False)
        self.assertEqual(paths, {"lib/http.js"})

    def test_rejects_traversal_absolute_git_and_symlink_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "link").symlink_to(workspace / "target", target_is_directory=False)
            for path in ("../escape", ".git/config", ".gitmodules", "link", "lib//http.js"):
                with self.subTest(path=path), self.assertRaises(PatchPolicyError):
                    validate_patch(patch_for(path), workspace, test_patch=False)

    def test_rejects_noncanonical_headers_and_special_git_modes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            wrong_prefix = patch_for("lib/http.js").replace(b"--- a/", b"--- b/")
            submodule = patch_for("vendor/dependency").replace(
                b"--- a/vendor/dependency\n",
                b"index 1111111..2222222 160000\n--- a/vendor/dependency\n",
            )
            for patch in (wrong_prefix, submodule):
                with self.subTest(patch=patch[:40]), self.assertRaises(PatchPolicyError):
                    validate_patch(patch, workspace, test_patch=False)

    def test_test_patch_uses_a_distinct_error_type(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(TestPatchPolicyError):
            validate_patch(b"not a patch", Path(directory), test_patch=True)

    def test_rejects_oversized_patches(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(PatchPolicyError):
            validate_patch(b"x" * (MAX_PATCH_BYTES + 1), Path(directory), test_patch=False)

    def test_hidden_test_patch_retains_the_one_mib_limit(self) -> None:
        oversized_test_patch = patch_for("test/http.js") + b"x" * MAX_PATCH_BYTES
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(TestPatchPolicyError):
            validate_patch(oversized_test_patch, Path(directory), test_patch=True)

    def test_rejects_candidate_test_path_conflict(self) -> None:
        with self.assertRaises(TestPatchConflictError):
            reject_path_conflict(frozenset({"test/http.js"}), frozenset({"test/http.js"}))


if __name__ == "__main__":
    unittest.main()
