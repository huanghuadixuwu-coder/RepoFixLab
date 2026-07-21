from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from .errors import PrivateSpecError

INSTANCE_ID = "axios__axios-5892"
BASE_COMMIT = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"
MAX_PATCH_BYTES = 1024 * 1024
MAX_CANDIDATE_PATCH_BYTES = 2 * 1024 * 1024
_INSTANCE_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,199}__[a-z0-9][a-z0-9_.-]{0,199}$")
_GIT_COMMIT = re.compile(r"^[a-f0-9]{40}$")


@dataclass(frozen=True)
class PrivateEvaluationSpec:
    instance_id: str
    base_commit: str
    test_patch: bytes
    gold_patch: bytes
    fail_to_pass: tuple[str, ...]
    pass_to_pass: tuple[str, ...]


@dataclass(frozen=True)
class TaskIdentity:
    """Controller-sealed public identity expected from one evaluator-private spec."""

    instance_id: str
    base_commit: str

    def __post_init__(self) -> None:
        if _INSTANCE_ID.fullmatch(self.instance_id) is None:
            raise PrivateSpecError("task instance ID violates the evaluator identity policy")
        if _GIT_COMMIT.fullmatch(self.base_commit) is None:
            raise PrivateSpecError("task base commit violates the evaluator identity policy")


AXIOS_SMOKE_TASK_IDENTITY = TaskIdentity(INSTANCE_ID, BASE_COMMIT)


def _strict_string_list(value: object, name: str, *, allow_empty: bool) -> tuple[str, ...]:
    if not isinstance(value, list) or (not allow_empty and not value):
        raise PrivateSpecError(f"{name} must be a non-empty string array")
    if any(not isinstance(item, str) or not item or len(item) > 1000 for item in value):
        raise PrivateSpecError(f"{name} contains an invalid test name")
    values = tuple(value)
    if len(set(values)) != len(values):
        raise PrivateSpecError(f"{name} contains duplicate test names")
    return values


def _patch_bytes(value: object, name: str) -> bytes:
    if not isinstance(value, str):
        raise PrivateSpecError(f"{name} must be UTF-8 text")
    data = value.encode("utf-8")
    if not data or len(data) > MAX_PATCH_BYTES or b"\x00" in data:
        raise PrivateSpecError(f"{name} violates the evaluator size or encoding policy")
    return data


def load_private_spec(
    path: Path,
    private_root: Path,
    expected_identity: TaskIdentity = AXIOS_SMOKE_TASK_IDENTITY,
) -> PrivateEvaluationSpec:
    root = private_root.resolve(strict=True)
    if not root.is_dir():
        raise PrivateSpecError("private root is not a directory")
    if path.is_symlink():
        raise PrivateSpecError("private spec must not be a symlink")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise PrivateSpecError("private spec is outside the evaluator-only root") from error
    descriptor = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        raw = os.read(descriptor, MAX_PATCH_BYTES * 2 + 256 * 1024 + 1)
    finally:
        os.close(descriptor)
    if len(raw) > MAX_PATCH_BYTES * 2 + 256 * 1024:
        raise PrivateSpecError("private spec exceeds its size limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PrivateSpecError("private spec is not strict UTF-8 JSON") from error
    required = {
        "schema_version",
        "instance_id",
        "base_commit",
        "test_patch",
        "gold_patch",
        "fail_to_pass",
        "pass_to_pass",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise PrivateSpecError("private spec fields do not match the v1 contract")
    if (
        value["schema_version"] != "v1"
        or value["instance_id"] != expected_identity.instance_id
        or value["base_commit"] != expected_identity.base_commit
    ):
        raise PrivateSpecError("private spec identity does not match the frozen task")
    fail_to_pass = _strict_string_list(value["fail_to_pass"], "fail_to_pass", allow_empty=False)
    pass_to_pass = _strict_string_list(value["pass_to_pass"], "pass_to_pass", allow_empty=True)
    if set(fail_to_pass) & set(pass_to_pass):
        raise PrivateSpecError("F2P and P2P test sets overlap")
    return PrivateEvaluationSpec(
        instance_id=expected_identity.instance_id,
        base_commit=expected_identity.base_commit,
        test_patch=_patch_bytes(value["test_patch"], "test_patch"),
        gold_patch=_patch_bytes(value["gold_patch"], "gold_patch"),
        fail_to_pass=fail_to_pass,
        pass_to_pass=pass_to_pass,
    )
