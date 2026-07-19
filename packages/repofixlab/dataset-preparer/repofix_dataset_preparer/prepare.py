from __future__ import annotations

import json
import os
import re
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .canonical import canonical_json, sha256_bytes
from .constants import (
    DATASET_NAME,
    DATASET_REVISION,
    DATASET_SOURCE_BYTES,
    DATASET_SOURCE_SHA256,
    DIFF_PARSER_VERSION,
    EXPECTED_RECORD_COUNT,
    EXPECTED_REPO_COUNTS,
    EXPECTED_SOURCE_RECORD_COUNT,
    JAVASCRIPT_TYPESCRIPT_REPOS,
    PRIVATE_FIELD_NAMES,
    REQUIRED_INSTANCE_ID,
    SCHEMA_VERSION,
)
from .diff import count_changed_hunk_records
from .errors import PreparationError
from .source import SourceAudit

_GENERATION = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_INSTANCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_IMAGE_ID = re.compile(r"^sha256:[a-f0-9]{64}$")
_VOLUME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RELATIVE_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
_LANGUAGES = frozenset({"javascript", "typescript", "javascript/typescript", "js", "ts"})
_PUBLISHED_FILE_MODE = 0o444
_PUBLISHED_DIRECTORY_MODE = 0o755


@dataclass(frozen=True)
class PreparationRequest:
    generation_id: str
    public_root: Path
    control_root: Path
    private_root: Path
    public_volume: str
    control_volume: str
    private_volume: str
    created_by_image_id: str
    source_audit: SourceAudit
    require_mounts: bool = True


@dataclass(frozen=True)
class _MaterializedFile:
    scope: str
    path: str
    content: bytes

    def descriptor(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "path": self.path,
            "bytes": len(self.content),
            "sha256": sha256_bytes(self.content),
        }


def _required_string(row: Mapping[str, Any], field: str, instance_hint: str) -> str:
    value = row.get(field)
    if not isinstance(value, str) or not value:
        raise PreparationError(f"{instance_hint}: required field {field!r} is missing or empty")
    return value


def _test_list(row: Mapping[str, Any], field: str, instance_id: str) -> list[str]:
    value = row.get(field)
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise PreparationError(f"{instance_id}: {field} is not valid JSON") from error
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise PreparationError(f"{instance_id}: {field} must be a list of non-empty strings")
    return value


def _normalize_issue(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _assert_language(row: Mapping[str, Any], instance_id: str) -> None:
    value = row.get("language")
    if value is None:
        return
    if not isinstance(value, str) or value.strip().lower() not in _LANGUAGES:
        raise PreparationError(f"{instance_id}: language is not JavaScript or TypeScript")


def _derive_records(
    rows: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    if len(rows) != EXPECTED_SOURCE_RECORD_COUNT:
        raise PreparationError(
            f"frozen source contains {len(rows)} rows; expected {EXPECTED_SOURCE_RECORD_COUNT}"
        )
    source_instance_ids: set[str] = set()
    for row in rows:
        instance_id = _required_string(row, "instance_id", "dataset row")
        if _INSTANCE_ID.fullmatch(instance_id) is None:
            raise PreparationError(f"invalid source instance_id: {instance_id!r}")
        if instance_id in source_instance_ids:
            raise PreparationError(f"duplicate source instance_id: {instance_id}")
        source_instance_ids.add(instance_id)

    candidates = [row for row in rows if row.get("repo") in JAVASCRIPT_TYPESCRIPT_REPOS]
    if len(candidates) != EXPECTED_RECORD_COUNT:
        raise PreparationError(
            f"frozen JS/TS filter produced {len(candidates)} rows; expected {EXPECTED_RECORD_COUNT}"
        )
    repo_counts = Counter(str(row.get("repo")) for row in candidates)
    if dict(repo_counts) != EXPECTED_REPO_COUNTS:
        raise PreparationError(
            f"frozen JS/TS repository counts differ: {dict(sorted(repo_counts.items()))}"
        )

    public_records: list[dict[str, Any]] = []
    control_records: list[dict[str, Any]] = []
    private_records: list[dict[str, Any]] = []
    seen: set[str] = set()
    seen_repos: set[str] = set()

    for row in candidates:
        instance_id = _required_string(row, "instance_id", "dataset row")
        if _INSTANCE_ID.fullmatch(instance_id) is None:
            raise PreparationError(f"invalid instance_id: {instance_id!r}")
        seen.add(instance_id)

        repo = _required_string(row, "repo", instance_id)
        seen_repos.add(repo)
        _assert_language(row, instance_id)
        problem_statement = _normalize_issue(
            _required_string(row, "problem_statement", instance_id)
        )
        base_commit = _required_string(row, "base_commit", instance_id)
        if _COMMIT.fullmatch(base_commit) is None:
            raise PreparationError(f"{instance_id}: base_commit must be a lowercase 40-hex commit")
        gold_patch = _required_string(row, "patch", instance_id)
        test_patch = _required_string(row, "test_patch", instance_id)
        version = _required_string(row, "version", instance_id)
        environment_setup_commit = row.get("environment_setup_commit")
        if environment_setup_commit in (None, ""):
            environment_setup_commit = None
        elif not isinstance(environment_setup_commit, str):
            raise PreparationError(
                f"{instance_id}: environment_setup_commit must be a string or null"
            )

        fail_to_pass = _test_list(row, "FAIL_TO_PASS", instance_id)
        pass_to_pass = _test_list(row, "PASS_TO_PASS", instance_id)
        if not fail_to_pass:
            raise PreparationError(f"{instance_id}: FAIL_TO_PASS must not be empty")

        public_records.append(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "dataset_task",
                "dataset_revision": DATASET_REVISION,
                "instance_id": instance_id,
                "repo": repo,
                "problem_statement": problem_statement,
                "base_commit": base_commit,
                "language": "JavaScript/TypeScript",
            }
        )
        control_records.append(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "sampling_metadata",
                "dataset_revision": DATASET_REVISION,
                "instance_id": instance_id,
                "repo": repo,
                "issue_bytes": len(problem_statement.encode("utf-8")),
                "gold_changed_lines": count_changed_hunk_records(gold_patch),
                "parser_version": DIFF_PARSER_VERSION,
            }
        )
        private_records.append(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "private_evaluation_spec",
                "dataset_revision": DATASET_REVISION,
                "instance_id": instance_id,
                "gold_patch": gold_patch,
                "test_patch": test_patch,
                "fail_to_pass": fail_to_pass,
                "pass_to_pass": pass_to_pass,
                "harness_parameters": {
                    "dataset_name": DATASET_NAME,
                    "dataset_revision": DATASET_REVISION,
                    "repo": repo,
                    "base_commit": base_commit,
                    "version": version,
                    "environment_setup_commit": environment_setup_commit,
                },
            }
        )

    if seen_repos != set(JAVASCRIPT_TYPESCRIPT_REPOS):
        missing = sorted(set(JAVASCRIPT_TYPESCRIPT_REPOS) - seen_repos)
        raise PreparationError(f"frozen JS/TS repository coverage is incomplete: {missing}")
    if REQUIRED_INSTANCE_ID not in seen:
        raise PreparationError(f"required bootstrap instance is missing: {REQUIRED_INSTANCE_ID}")

    key = lambda record: record["instance_id"]
    return (
        sorted(public_records, key=key),
        sorted(control_records, key=key),
        sorted(private_records, key=key),
    )


def _contains_forbidden_key(value: Any) -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in PRIVATE_FIELD_NAMES:
                return key
            nested = _contains_forbidden_key(child)
            if nested is not None:
                return nested
    elif isinstance(value, list):
        for child in value:
            nested = _contains_forbidden_key(child)
            if nested is not None:
                return nested
    return None


def _audit_information_boundaries(
    public_records: Sequence[dict[str, Any]],
    control_records: Sequence[dict[str, Any]],
    private_records: Sequence[dict[str, Any]],
) -> None:
    public_ids = {record["instance_id"] for record in public_records}
    control_ids = {record["instance_id"] for record in control_records}
    private_ids = {record["instance_id"] for record in private_records}
    if public_ids != control_ids or public_ids != private_ids:
        raise PreparationError("public/control/private instance cross-references differ")

    private_by_id = {record["instance_id"]: record for record in private_records}
    for record in public_records:
        forbidden = _contains_forbidden_key(record)
        if forbidden is not None:
            raise PreparationError(f"public task leaks forbidden field {forbidden!r}")
        serialized = canonical_json(record)
        private = private_by_id[record["instance_id"]]
        for field in ("gold_patch", "test_patch"):
            secret = private[field].encode("utf-8")
            if secret and secret in serialized:
                raise PreparationError(f"public task contains the full private {field}")

    for record in control_records:
        serialized = canonical_json(record)
        private = private_by_id[record["instance_id"]]
        for field in ("gold_patch", "test_patch"):
            secret = private[field].encode("utf-8")
            if secret and secret in serialized:
                raise PreparationError(f"control metadata contains the full private {field}")


def _make_scope_files(
    scope: str,
    records: Sequence[dict[str, Any]],
    generation_id: str,
) -> list[_MaterializedFile]:
    files: list[_MaterializedFile] = []
    index_records: list[dict[str, Any]] = []
    for record in records:
        path = f"tasks/{record['instance_id']}.json"
        content = canonical_json(record)
        files.append(_MaterializedFile(scope=scope, path=path, content=content))
        index_records.append(
            {
                "instance_id": record["instance_id"],
                "path": path,
                "bytes": len(content),
                "sha256": sha256_bytes(content),
            }
        )
    jsonl_name = {
        "public": "tasks.jsonl",
        "control": "sampling.jsonl",
        "private": "evaluation.jsonl",
    }[scope]
    files.append(
        _MaterializedFile(
            scope=scope,
            path=jsonl_name,
            content=b"".join(canonical_json(record) for record in records),
        )
    )
    files.append(
        _MaterializedFile(
            scope=scope,
            path="index.json",
            content=canonical_json(
                {
                    "schema_version": SCHEMA_VERSION,
                    "index_type": "dataset_scope",
                    "scope": scope,
                    "dataset": {"name": DATASET_NAME, "revision": DATASET_REVISION},
                    "generation_id": generation_id,
                    "record_count": len(records),
                    "records": index_records,
                }
            ),
        )
    )
    return files


def _mount_points() -> dict[str, frozenset[str]]:
    mount_points: dict[str, frozenset[str]] = {}
    try:
        lines = Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise PreparationError("cannot inspect Linux mount topology") from error
    for line in lines:
        fields = line.split()
        if len(fields) < 7:
            continue
        mount_point = (
            fields[4]
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
            .replace("\\134", "\\")
        )
        mount_points[mount_point] = frozenset(fields[5].split(","))
    return mount_points


def validate_preparation_request_metadata(
    *,
    generation_id: str,
    public_volume: str,
    control_volume: str,
    private_volume: str,
    created_by_image_id: str,
) -> None:
    if not isinstance(generation_id, str) or _GENERATION.fullmatch(generation_id) is None:
        raise PreparationError("generation_id must match [a-z0-9][a-z0-9-]{0,63}")
    if (
        not isinstance(created_by_image_id, str)
        or _IMAGE_ID.fullmatch(created_by_image_id) is None
    ):
        raise PreparationError("created_by_image_id must be an immutable sha256 image ID")

    volumes = {
        "public": public_volume,
        "control": control_volume,
        "private": private_volume,
    }
    for scope, volume in volumes.items():
        if not isinstance(volume, str) or _VOLUME.fullmatch(volume) is None:
            raise PreparationError(f"invalid {scope} volume name")
        if volume != f"dataset-{scope}-{generation_id}":
            raise PreparationError(f"{scope} volume does not bind the generation ID")
    if len(set(volumes.values())) != 3:
        raise PreparationError("dataset volumes must be distinct")


def _validate_request(request: PreparationRequest) -> dict[str, Path]:
    validate_preparation_request_metadata(
        generation_id=request.generation_id,
        public_volume=request.public_volume,
        control_volume=request.control_volume,
        private_volume=request.private_volume,
        created_by_image_id=request.created_by_image_id,
    )
    if _SHA256.fullmatch(request.source_audit.source_sha256) is None:
        raise PreparationError("source audit must contain a lowercase SHA-256")
    if request.source_audit.source_sha256 != DATASET_SOURCE_SHA256:
        raise PreparationError("source audit SHA-256 does not match the frozen dataset object")
    if request.source_audit.source_bytes != DATASET_SOURCE_BYTES:
        raise PreparationError("source audit byte count does not match the frozen dataset object")
    if request.source_audit.source_kind not in {"file", "https"}:
        raise PreparationError("source audit kind must be file or https")
    if request.source_audit.source_kind == "file" and (
        request.source_audit.requested_url is not None
        or request.source_audit.final_url is not None
        or request.source_audit.redirect_chain
    ):
        raise PreparationError("file source audit must not contain network locations")
    if request.source_audit.source_kind == "https" and (
        not isinstance(request.source_audit.requested_url, str)
        or not isinstance(request.source_audit.final_url, str)
    ):
        raise PreparationError("HTTPS source audit must contain requested and final URLs")

    requested_roots = {
        "public": request.public_root,
        "control": request.control_root,
        "private": request.private_root,
    }
    if any(root.is_symlink() for root in requested_roots.values()):
        raise PreparationError("dataset roots must not be symbolic links")
    roots = {scope: root.resolve(strict=True) for scope, root in requested_roots.items()}
    if len(set(roots.values())) != 3:
        raise PreparationError("dataset roots must be distinct")
    for scope, root in roots.items():
        if not root.is_dir():
            raise PreparationError(f"{scope} root must be a real directory")
        if any(root.iterdir()):
            raise PreparationError(f"{scope} generation is not empty; refusing in-place overwrite")
    for left in roots.values():
        for right in roots.values():
            if left != right and (left in right.parents or right in left.parents):
                raise PreparationError("dataset roots must not be nested")

    if request.require_mounts:
        mount_points = _mount_points()
        for scope, root in roots.items():
            options = mount_points.get(str(root))
            if options is None or "rw" not in options:
                raise PreparationError(f"{scope} root is not a dedicated read-write mount point")
    for root in roots.values():
        os.chmod(root, _PUBLISHED_DIRECTORY_MODE)
    return roots

def _set_published_file_mode(descriptor: int, path: Path) -> None:
    if os.name == "nt":
        os.chmod(path, _PUBLISHED_FILE_MODE)
    else:
        os.fchmod(descriptor, _PUBLISHED_FILE_MODE)



def _write_atomic(root: Path, relative_path: str, content: bytes) -> None:
    destination = root / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(destination.parent, _PUBLISHED_DIRECTORY_MODE)
    descriptor, temporary = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            _set_published_file_mode(stream.fileno(), Path(temporary))
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _claim_writer(control_root: Path, content: bytes) -> None:
    claim = control_root / "WRITER"
    try:
        descriptor = os.open(
            claim,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            _PUBLISHED_FILE_MODE,
        )
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            _set_published_file_mode(stream.fileno(), claim)
            os.fsync(stream.fileno())
        directory_fd = os.open(control_root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except FileExistsError as error:
        raise PreparationError("dataset generation already has a writer claim") from error
    except OSError as error:
        raise PreparationError("failed to establish the dataset writer claim") from error


def _verify_file(root: Path, descriptor: Mapping[str, Any]) -> None:
    path = root / descriptor["path"]
    try:
        content = path.read_bytes()
    except OSError as error:
        raise PreparationError(f"missing materialized file: {descriptor['path']}") from error
    if len(content) != descriptor["bytes"] or sha256_bytes(content) != descriptor["sha256"]:
        raise PreparationError(f"materialized file checksum mismatch: {descriptor['path']}")


def _validate_sealed_record(scope: str, value: Mapping[str, Any]) -> None:
    common_valid = (
        value.get("schema_version") == SCHEMA_VERSION
        and value.get("dataset_revision") == DATASET_REVISION
        and isinstance(value.get("instance_id"), str)
    )
    if not common_valid:
        raise PreparationError(f"{scope} task has an invalid common record envelope")

    if scope == "public":
        expected_keys = {
            "schema_version",
            "record_type",
            "dataset_revision",
            "instance_id",
            "repo",
            "problem_statement",
            "base_commit",
            "language",
        }
        if (
            set(value) != expected_keys
            or value.get("record_type") != "dataset_task"
            or value.get("repo") not in JAVASCRIPT_TYPESCRIPT_REPOS
            or not isinstance(value.get("problem_statement"), str)
            or not value.get("problem_statement")
            or _COMMIT.fullmatch(str(value.get("base_commit", ""))) is None
            or value.get("language") != "JavaScript/TypeScript"
        ):
            raise PreparationError("public task record violates the frozen field allowlist")
        if _contains_forbidden_key(value) is not None:
            raise PreparationError("public task contains a private/control-only field")
        return

    if scope == "control":
        expected_keys = {
            "schema_version",
            "record_type",
            "dataset_revision",
            "instance_id",
            "repo",
            "issue_bytes",
            "gold_changed_lines",
            "parser_version",
        }
        issue_bytes = value.get("issue_bytes")
        changed_lines = value.get("gold_changed_lines")
        if (
            set(value) != expected_keys
            or value.get("record_type") != "sampling_metadata"
            or value.get("repo") not in JAVASCRIPT_TYPESCRIPT_REPOS
            or not isinstance(issue_bytes, int)
            or isinstance(issue_bytes, bool)
            or issue_bytes < 1
            or not isinstance(changed_lines, int)
            or isinstance(changed_lines, bool)
            or changed_lines < 1
            or value.get("parser_version") != DIFF_PARSER_VERSION
        ):
            raise PreparationError("control task record violates the frozen field allowlist")
        return

    expected_keys = {
        "schema_version",
        "record_type",
        "dataset_revision",
        "instance_id",
        "gold_patch",
        "test_patch",
        "fail_to_pass",
        "pass_to_pass",
        "harness_parameters",
    }
    harness = value.get("harness_parameters")
    if (
        set(value) != expected_keys
        or value.get("record_type") != "private_evaluation_spec"
        or not isinstance(value.get("gold_patch"), str)
        or not value.get("gold_patch")
        or not isinstance(value.get("test_patch"), str)
        or not value.get("test_patch")
        or not isinstance(value.get("fail_to_pass"), list)
        or not value.get("fail_to_pass")
        or not all(isinstance(item, str) and item for item in value["fail_to_pass"])
        or not isinstance(value.get("pass_to_pass"), list)
        or not all(isinstance(item, str) and item for item in value["pass_to_pass"])
        or not isinstance(harness, dict)
        or set(harness)
        != {
            "dataset_name",
            "dataset_revision",
            "repo",
            "base_commit",
            "version",
            "environment_setup_commit",
        }
        or harness.get("dataset_name") != DATASET_NAME
        or harness.get("dataset_revision") != DATASET_REVISION
        or harness.get("repo") not in JAVASCRIPT_TYPESCRIPT_REPOS
        or _COMMIT.fullmatch(str(harness.get("base_commit", ""))) is None
        or not isinstance(harness.get("version"), str)
        or not harness.get("version")
        or (
            harness.get("environment_setup_commit") is not None
            and not isinstance(harness.get("environment_setup_commit"), str)
        )
    ):
        raise PreparationError("private task record violates the frozen field allowlist")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def prepare_generation(
    rows: Sequence[Mapping[str, Any]],
    request: PreparationRequest,
    *,
    clock: Callable[[], str] = _utc_now,
) -> dict[str, Any]:
    roots = _validate_request(request)
    writer_claim = canonical_json(
        {
            "schema_version": SCHEMA_VERSION,
            "claim_type": "dataset_generation_writer",
            "generation_id": request.generation_id,
            "created_by_image_id": request.created_by_image_id,
            "source_sha256": request.source_audit.source_sha256,
        }
    )
    _claim_writer(roots["control"], writer_claim)
    public_records, control_records, private_records = _derive_records(rows)
    _audit_information_boundaries(public_records, control_records, private_records)

    files = [
        *_make_scope_files("public", public_records, request.generation_id),
        *_make_scope_files("control", control_records, request.generation_id),
        *_make_scope_files("private", private_records, request.generation_id),
    ]
    files.append(
        _MaterializedFile(scope="control", path="WRITER", content=writer_claim)
    )
    files.append(
        _MaterializedFile(
            scope="control",
            path="source-audit.json",
            content=canonical_json(
                {
                    "schema_version": SCHEMA_VERSION,
                    "audit_type": "dataset_source",
                    "dataset": {"name": DATASET_NAME, "revision": DATASET_REVISION},
                    "generation_id": request.generation_id,
                    "source_kind": request.source_audit.source_kind,
                    "source_sha256": request.source_audit.source_sha256,
                    "source_bytes": request.source_audit.source_bytes,
                    "requested_url": request.source_audit.requested_url,
                    "final_url": request.source_audit.final_url,
                    "redirect_chain": list(request.source_audit.redirect_chain),
                }
            ),
        )
    )
    descriptors = sorted(
        (file.descriptor() for file in files), key=lambda value: (value["scope"], value["path"])
    )
    aggregate_sha256 = sha256_bytes(canonical_json(descriptors))
    created_at = clock()
    ready_content = canonical_json(
        {
            "schema_version": SCHEMA_VERSION,
            "marker_type": "dataset_generation",
            "state": "ready",
            "dataset": {"name": DATASET_NAME, "revision": DATASET_REVISION},
            "generation_id": request.generation_id,
            "record_count": EXPECTED_RECORD_COUNT,
            "aggregate_sha256": aggregate_sha256,
            "source_sha256": request.source_audit.source_sha256,
            "written_at": created_at,
        }
    )
    ready_sha256 = sha256_bytes(ready_content)
    seal_content = canonical_json(
        {
            "schema_version": SCHEMA_VERSION,
            "marker_type": "dataset_generation",
            "state": "sealed",
            "dataset": {"name": DATASET_NAME, "revision": DATASET_REVISION},
            "generation_id": request.generation_id,
            "record_count": EXPECTED_RECORD_COUNT,
            "aggregate_sha256": aggregate_sha256,
            "ready_sha256": ready_sha256,
            "written_at": created_at,
        }
    )
    seal_sha256 = sha256_bytes(seal_content)

    try:
        for file in files:
            _write_atomic(roots[file.scope], file.path, file.content)
        for descriptor in descriptors:
            _verify_file(roots[descriptor["scope"]], descriptor)
        for scope in ("public", "control", "private"):
            _write_atomic(roots[scope], "READY", ready_content)
        for scope in ("public", "control", "private"):
            marker = (roots[scope] / "READY").read_bytes()
            if sha256_bytes(marker) != ready_sha256:
                raise PreparationError(f"{scope} READY marker verification failed")
        for scope in ("public", "control", "private"):
            _write_atomic(roots[scope], "SEAL", seal_content)
        for scope in ("public", "control", "private"):
            marker = (roots[scope] / "SEAL").read_bytes()
            if sha256_bytes(marker) != seal_sha256:
                raise PreparationError(f"{scope} SEAL marker verification failed")
    except PreparationError:
        raise
    except BaseException as error:
        raise PreparationError("dataset staging write failed; generation was not published") from error

    lock_id = f"dataset-v1-{request.generation_id}-{aggregate_sha256[:16]}"
    dataset_lock: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "lock_type": "dataset",
        "lock_id": lock_id,
        "dataset": {"name": DATASET_NAME, "revision": DATASET_REVISION},
        "generation_id": request.generation_id,
        "volumes": {
            "public": request.public_volume,
            "control": request.control_volume,
            "private": request.private_volume,
        },
        "record_count": EXPECTED_RECORD_COUNT,
        "files": descriptors,
        "aggregate_sha256": aggregate_sha256,
        "ready": {"sha256": ready_sha256, "written_at": created_at},
        "seal": {"sha256": seal_sha256, "written_at": created_at},
        "created_by_image_id": request.created_by_image_id,
        "created_at": created_at,
    }
    verify_generation(dataset_lock, roots)
    return dataset_lock


def verify_generation(dataset_lock: Mapping[str, Any], roots: Mapping[str, Path]) -> None:
    if set(roots) != {"public", "control", "private"}:
        raise PreparationError("generation verification requires exactly three dataset scopes")
    if dataset_lock.get("schema_version") != SCHEMA_VERSION or dataset_lock.get("lock_type") != "dataset":
        raise PreparationError("unsupported DatasetLock schema or lock type")
    if dataset_lock.get("dataset") != {"name": DATASET_NAME, "revision": DATASET_REVISION}:
        raise PreparationError("DatasetLock does not bind the frozen dataset")
    if dataset_lock.get("record_count") != EXPECTED_RECORD_COUNT:
        raise PreparationError("DatasetLock record count differs from the frozen protocol")
    generation_id = dataset_lock.get("generation_id")
    if not isinstance(generation_id, str) or _GENERATION.fullmatch(generation_id) is None:
        raise PreparationError("DatasetLock generation ID is invalid")
    expected_volumes = {
        scope: f"dataset-{scope}-{generation_id}" for scope in ("public", "control", "private")
    }
    if dataset_lock.get("volumes") != expected_volumes:
        raise PreparationError("DatasetLock volume names do not bind the generation ID")
    if _IMAGE_ID.fullmatch(str(dataset_lock.get("created_by_image_id", ""))) is None:
        raise PreparationError("DatasetLock creator image ID is invalid")
    descriptors = dataset_lock.get("files")
    if not isinstance(descriptors, list) or not descriptors:
        raise PreparationError("DatasetLock contains no file descriptors")
    if not all(isinstance(descriptor, dict) for descriptor in descriptors):
        raise PreparationError("DatasetLock file descriptor must be an object")
    if descriptors != sorted(
        descriptors, key=lambda value: (str(value.get("scope")), str(value.get("path")))
    ):
        raise PreparationError("DatasetLock file descriptors are not in canonical order")
    if sha256_bytes(canonical_json(descriptors)) != dataset_lock.get("aggregate_sha256"):
        raise PreparationError("DatasetLock aggregate SHA-256 mismatch")

    seen_paths: set[tuple[str, str]] = set()
    for descriptor in descriptors:
        if not isinstance(descriptor, dict) or set(descriptor) != {"scope", "path", "bytes", "sha256"}:
            raise PreparationError("DatasetLock file descriptor must be an object")
        scope = descriptor.get("scope")
        path = descriptor.get("path")
        byte_count = descriptor.get("bytes")
        digest = descriptor.get("sha256")
        if (
            scope not in roots
            or not isinstance(path, str)
            or _RELATIVE_PATH.fullmatch(path) is None
            or path.startswith("/")
            or ".." in Path(path).parts
        ):
            raise PreparationError("DatasetLock contains an unsafe file descriptor")
        if not isinstance(byte_count, int) or isinstance(byte_count, bool) or byte_count < 0:
            raise PreparationError("DatasetLock contains an invalid file byte count")
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise PreparationError("DatasetLock contains an invalid file SHA-256")
        if (scope, path) in seen_paths:
            raise PreparationError("DatasetLock contains a duplicate file descriptor")
        seen_paths.add((scope, path))
        _verify_file(roots[scope], descriptor)

    expected_layout = {
        "public": {"index.json", "tasks.jsonl"},
        "control": {"WRITER", "index.json", "sampling.jsonl", "source-audit.json"},
        "private": {"index.json", "evaluation.jsonl"},
    }
    for scope in expected_layout:
        expected_layout[scope].update(
            path for descriptor_scope, path in seen_paths if descriptor_scope == scope and path.startswith("tasks/")
        )
        described = {path for descriptor_scope, path in seen_paths if descriptor_scope == scope}
        if described != expected_layout[scope]:
            raise PreparationError(f"{scope} DatasetLock file layout is incomplete or unexpected")
        actual: set[str] = set()
        for path in roots[scope].rglob("*"):
            if path.is_symlink():
                raise PreparationError(f"{scope} generation contains a symbolic link")
            if path.is_file():
                actual.add(path.relative_to(roots[scope]).as_posix())
        if actual != described | {"READY", "SEAL"}:
            raise PreparationError(f"{scope} generation contains untracked files")

    records_by_scope: dict[str, list[dict[str, Any]]] = {}
    for scope in ("public", "control", "private"):
        task_paths = sorted(path for descriptor_scope, path in seen_paths if descriptor_scope == scope and path.startswith("tasks/"))
        if len(task_paths) != EXPECTED_RECORD_COUNT:
            raise PreparationError(f"{scope} generation does not contain exactly 43 task files")
        records: list[dict[str, Any]] = []
        for relative_path in task_paths:
            try:
                value = json.loads((roots[scope] / relative_path).read_bytes())
            except (OSError, json.JSONDecodeError) as error:
                raise PreparationError(f"{scope} task file is not valid JSON: {relative_path}") from error
            if not isinstance(value, dict):
                raise PreparationError(f"{scope} task file must be an object: {relative_path}")
            instance_id = value.get("instance_id")
            if not isinstance(instance_id, str) or relative_path != f"tasks/{instance_id}.json":
                raise PreparationError(f"{scope} task file path and instance ID differ")
            if value.get("schema_version") != SCHEMA_VERSION or value.get("dataset_revision") != DATASET_REVISION:
                raise PreparationError(f"{scope} task does not bind the frozen schema and revision")
            _validate_sealed_record(scope, value)
            records.append(value)
        records_by_scope[scope] = records

        try:
            index = json.loads((roots[scope] / "index.json").read_bytes())
        except (OSError, json.JSONDecodeError) as error:
            raise PreparationError(f"{scope} index is not valid JSON") from error
        expected_index_records = []
        descriptor_by_path = {
            descriptor["path"]: descriptor
            for descriptor in descriptors
            if descriptor["scope"] == scope
        }
        for record in records:
            relative_path = f"tasks/{record['instance_id']}.json"
            file_descriptor = descriptor_by_path[relative_path]
            expected_index_records.append(
                {
                    "instance_id": record["instance_id"],
                    "path": relative_path,
                    "bytes": file_descriptor["bytes"],
                    "sha256": file_descriptor["sha256"],
                }
            )
        expected_index = {
            "schema_version": SCHEMA_VERSION,
            "index_type": "dataset_scope",
            "scope": scope,
            "dataset": {"name": DATASET_NAME, "revision": DATASET_REVISION},
            "generation_id": generation_id,
            "record_count": EXPECTED_RECORD_COUNT,
            "records": expected_index_records,
        }
        if index != expected_index:
            raise PreparationError(f"{scope} index cross-references do not match task files")
        jsonl_name = {
            "public": "tasks.jsonl",
            "control": "sampling.jsonl",
            "private": "evaluation.jsonl",
        }[scope]
        expected_jsonl = b"".join(canonical_json(record) for record in records)
        if (roots[scope] / jsonl_name).read_bytes() != expected_jsonl:
            raise PreparationError(f"{scope} JSONL does not match its task records")

    _audit_information_boundaries(
        records_by_scope["public"], records_by_scope["control"], records_by_scope["private"]
    )
    instance_sets = [
        {record["instance_id"] for record in records_by_scope[scope]}
        for scope in ("public", "control", "private")
    ]
    if not (instance_sets[0] == instance_sets[1] == instance_sets[2]):
        raise PreparationError("sealed public/control/private task references differ")
    public_by_id = {record["instance_id"]: record for record in records_by_scope["public"]}
    control_by_id = {record["instance_id"]: record for record in records_by_scope["control"]}
    private_by_id = {record["instance_id"]: record for record in records_by_scope["private"]}
    for instance_id, public in public_by_id.items():
        control = control_by_id[instance_id]
        private = private_by_id[instance_id]
        harness = private["harness_parameters"]
        if control["repo"] != public["repo"] or harness["repo"] != public["repo"]:
            raise PreparationError(f"{instance_id}: repository cross-reference mismatch")
        if harness["base_commit"] != public["base_commit"]:
            raise PreparationError(f"{instance_id}: base commit cross-reference mismatch")
        if control["issue_bytes"] != len(public["problem_statement"].encode("utf-8")):
            raise PreparationError(f"{instance_id}: issue byte count cross-reference mismatch")
        if control["gold_changed_lines"] != count_changed_hunk_records(private["gold_patch"]):
            raise PreparationError(f"{instance_id}: gold changed-line cross-reference mismatch")

    try:
        source_audit = json.loads((roots["control"] / "source-audit.json").read_bytes())
    except (OSError, json.JSONDecodeError) as error:
        raise PreparationError("source audit is not valid JSON") from error
    if not isinstance(source_audit, dict):
        raise PreparationError("source audit must be a JSON object")
    expected_source_audit_keys = {
        "schema_version",
        "audit_type",
        "dataset",
        "generation_id",
        "source_kind",
        "source_sha256",
        "source_bytes",
        "requested_url",
        "final_url",
        "redirect_chain",
    }
    source_bytes = source_audit.get("source_bytes")
    if (
        set(source_audit) != expected_source_audit_keys
        or source_audit.get("schema_version") != SCHEMA_VERSION
        or source_audit.get("audit_type") != "dataset_source"
        or source_audit.get("dataset") != {"name": DATASET_NAME, "revision": DATASET_REVISION}
        or source_audit.get("generation_id") != generation_id
        or source_audit.get("source_sha256") != DATASET_SOURCE_SHA256
        or not isinstance(source_bytes, int)
        or isinstance(source_bytes, bool)
        or source_bytes != DATASET_SOURCE_BYTES
        or source_audit.get("source_kind") not in {"file", "https"}
        or not isinstance(source_audit.get("redirect_chain"), list)
        or not all(isinstance(url, str) for url in source_audit["redirect_chain"])
    ):
        raise PreparationError("source audit does not bind the sealed generation")
    if source_audit["source_kind"] == "file" and (
        source_audit["requested_url"] is not None
        or source_audit["final_url"] is not None
        or source_audit["redirect_chain"]
    ):
        raise PreparationError("sealed file source audit contains network locations")
    if source_audit["source_kind"] == "https" and (
        not isinstance(source_audit["requested_url"], str)
        or not isinstance(source_audit["final_url"], str)
    ):
        raise PreparationError("sealed HTTPS source audit is missing network locations")
    try:
        writer_claim = json.loads((roots["control"] / "WRITER").read_bytes())
    except (OSError, json.JSONDecodeError) as error:
        raise PreparationError("writer claim is not valid JSON") from error
    expected_writer_claim = {
        "schema_version": SCHEMA_VERSION,
        "claim_type": "dataset_generation_writer",
        "generation_id": generation_id,
        "created_by_image_id": dataset_lock.get("created_by_image_id"),
        "source_sha256": source_audit.get("source_sha256"),
    }
    if writer_claim != expected_writer_claim:
        raise PreparationError("writer claim does not bind the sealed generation")

    ready = dataset_lock.get("ready")
    seal = dataset_lock.get("seal")
    if not isinstance(ready, dict) or not isinstance(seal, dict):
        raise PreparationError("DatasetLock markers are missing")
    for scope, root in roots.items():
        try:
            ready_content = (root / "READY").read_bytes()
            seal_content = (root / "SEAL").read_bytes()
        except OSError as error:
            raise PreparationError(f"{scope} generation is not fully sealed") from error
        if sha256_bytes(ready_content) != ready.get("sha256"):
            raise PreparationError(f"{scope} READY hash differs from DatasetLock")
        if sha256_bytes(seal_content) != seal.get("sha256"):
            raise PreparationError(f"{scope} SEAL hash differs from DatasetLock")
        try:
            ready_value = json.loads(ready_content)
            seal_value = json.loads(seal_content)
        except json.JSONDecodeError as error:
            raise PreparationError(f"{scope} READY/SEAL marker is not valid JSON") from error
        if (
            ready_value.get("state") != "ready"
            or ready_value.get("dataset") != {"name": DATASET_NAME, "revision": DATASET_REVISION}
            or ready_value.get("generation_id") != generation_id
            or ready_value.get("record_count") != EXPECTED_RECORD_COUNT
            or ready_value.get("aggregate_sha256") != dataset_lock.get("aggregate_sha256")
            or ready_value.get("source_sha256") != source_audit.get("source_sha256")
        ):
            raise PreparationError(f"{scope} READY marker does not bind DatasetLock")
        if (
            seal_value.get("state") != "sealed"
            or seal_value.get("dataset") != {"name": DATASET_NAME, "revision": DATASET_REVISION}
            or seal_value.get("generation_id") != generation_id
            or seal_value.get("record_count") != EXPECTED_RECORD_COUNT
            or seal_value.get("aggregate_sha256") != dataset_lock.get("aggregate_sha256")
            or seal_value.get("ready_sha256") != ready.get("sha256")
        ):
            raise PreparationError(f"{scope} SEAL marker does not bind DatasetLock")
