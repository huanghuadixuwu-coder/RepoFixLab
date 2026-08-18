from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import tarfile
from time import monotonic, sleep
from types import MappingProxyType

from jsonschema import Draft202012Validator

from .container_factory import DockerClientProtocol, RoleLaunchPolicy
from .factory_service import (
    TrustedCandidate,
    TrustedCandidateCatalog,
    validate_candidate_images,
)
from .runtime_service import (
    RuntimeCleanupResult,
    RuntimeJobStatus,
    RuntimePreflightManifest,
    RuntimeServiceUnavailable,
)
from .runtime_tools import (
    RUNTIME_TOOL_NAMES,
    RuntimeCreateMetadata,
    RuntimeEditMetadata,
    RuntimeLineSpan,
    RuntimeReadMetadata,
    RuntimeReplaceMetadata,
    RuntimeSnapshotEvidence,
    RuntimeSnapshotFile,
    RuntimeToolError,
    RuntimeToolName,
    RuntimeToolResult,
    RuntimeVerificationCatalog,
    RuntimeVerificationCatalogEntry,
    RuntimeVerificationObservation,
    RuntimeVerificationResult,
    runtime_text_line_count,
)


# Kept for the M1 fixture tests only. Production runtime paths derive these
# values from each sealed DatasetLock and never read these constants.
RUNTIME_PRIVATE_VOLUME = "dataset-private-g-20260718-135934-066a8f5b6f6b"
RUNTIME_EVALUATOR_ARTIFACTS = (
    "evaluation.json",
    "evaluator.log",
    "patch-apply.json",
)

_MANAGED_LABEL = "io.repofixlab.runtime.managed"
_ATTEMPT_LABEL = "io.repofixlab.runtime.attempt-id"
_CANDIDATE_LABEL = "io.repofixlab.runtime.candidate-id"
_ROLE_LABEL = "io.repofixlab.runtime.role"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_IMAGE_ID = re.compile(r"^sha256:[a-f0-9]{64}$")
_CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")
_VOLUME_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_GIT_OBJECT_ID = re.compile(r"^[a-f0-9]{40}$")
_INSTANCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$")
_KERNEL_LIMIT_BYTES = 2 * 1024 * 1024
_KERNEL_FILE_LIMIT = 128
_ARCHIVE_LIMIT_BYTES = 4 * 1024 * 1024
_ARTIFACT_LIMIT_BYTES = 1024 * 1024
_WORKER_HELPER_ROOT = "/tmp/repofixlab-runtime-worker"
_WORKER_ENTRY = f"{_WORKER_HELPER_ROOT}/runtime_worker_entry.py"
_EVALUATOR_KERNEL_ROOT = "/tmp/repofixlab-runtime"
_PRIVATE_ROOT = "/run/repofixlab/private"
_INPUT_ROOT = "/run/repofixlab/input"
_EVIDENCE_ROOT = "/run/repofixlab/evidence"
_WORKSPACE_ROOT = "/testbed"
_M6_KERNEL_ROOT = "/opt/repofixlab"
_M6_PREPARED_ROOT = "/run/repofixlab/private"
_M6_EVIDENCE_ROOT = "/run/repofixlab/evidence"
_M6_DATASET_ROOT = "/data/private"
_M6_PRISTINE_IMAGE = "repofixlab/pristine-harness:m0-726c5461-final"

_KEEPALIVE_SCRIPT = "import signal; signal.pause()"


def _task_environment_lock_id(instance_id: str, seal_sha256: str) -> str:
    if _INSTANCE_ID.fullmatch(instance_id) is None or "__" not in instance_id:
        raise RuntimeDockerError("TaskEnvironmentLock instance ID is invalid")
    repository, task = instance_id.split("__", 1)
    if not repository or not task:
        raise RuntimeDockerError("TaskEnvironmentLock instance ID is not repository-qualified")
    prefix = task if task.startswith(f"{repository}-") else f"{repository}-{task}"
    return f"task-environment-v1-{prefix}-{seal_sha256[:16]}"


def _task_environment_lock_directory(instance_id: str) -> str:
    if _INSTANCE_ID.fullmatch(instance_id) is None:
        raise RuntimeDockerError("TaskEnvironmentLock instance ID is invalid")
    repository, separator, task = instance_id.partition("__")
    if not separator or not repository or not task:
        raise RuntimeDockerError("TaskEnvironmentLock instance ID is not repository-qualified")
    return task if task.startswith(f"{repository}-") else f"{repository}-{task}"
_STDIN_WRITE_SCRIPT = r"""
import hashlib
import os
from pathlib import PurePosixPath
import stat
import sys

root, relative, expected_size_text, expected_sha256 = sys.argv[1:]
expected_size = int(expected_size_text)
pure = PurePosixPath(relative)
if pure.is_absolute() or not pure.parts or any(part in {'', '.', '..'} for part in pure.parts):
    raise SystemExit(64)
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0)
directory = os.open(root, flags)
try:
    for part in pure.parts[:-1]:
        try:
            os.mkdir(part, 0o700, dir_fd=directory)
        except FileExistsError:
            pass
        child = os.open(part, flags, dir_fd=directory)
        os.close(directory)
        directory = child
    target_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(pure.parts[-1], target_flags, 0o400, dir_fd=directory)
    digest = hashlib.sha256()
    received = 0
    try:
        while received < expected_size:
            chunk = sys.stdin.buffer.read(min(65536, expected_size - received))
            if not chunk:
                raise SystemExit(65)
            offset = 0
            while offset < len(chunk):
                offset += os.write(descriptor, chunk[offset:])
            digest.update(chunk)
            received += len(chunk)
        if sys.stdin.buffer.read(1):
            raise SystemExit(66)
        os.fsync(descriptor)
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode) or observed.st_size != expected_size:
            raise SystemExit(67)
    except BaseException:
        os.close(descriptor)
        os.unlink(pure.parts[-1], dir_fd=directory)
        raise
    os.close(descriptor)
    if digest.hexdigest() != expected_sha256:
        os.unlink(pure.parts[-1], dir_fd=directory)
        raise SystemExit(68)
finally:
    os.close(directory)
""".strip()
_VERIFY_FILE_SCRIPT = r"""
import hashlib
import os
import stat
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
try:
    observed = os.fstat(descriptor)
    if not stat.S_ISREG(observed.st_mode):
        raise SystemExit(64)
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = os.read(descriptor, 65536)
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
finally:
    os.close(descriptor)
print(f'{size}:{digest.hexdigest()}')
""".strip()
_PUBLISH_READY_SCRIPT = r"""
import hashlib
import os
import stat
import sys

source, target, expected_size_text, expected_sha256 = sys.argv[1:]
descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
try:
    observed = os.fstat(descriptor)
    content = os.read(descriptor, int(expected_size_text) + 1)
finally:
    os.close(descriptor)
if (
    not stat.S_ISREG(observed.st_mode)
    or observed.st_size != int(expected_size_text)
    or hashlib.sha256(content).hexdigest() != expected_sha256
):
    raise SystemExit(64)
os.link(source, target, follow_symlinks=False)
os.unlink(source)
print(expected_sha256)
""".strip()
_EVALUATOR_WAIT_SCRIPT = r"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

root = Path('/tmp/repofixlab-runtime/repofixlab_evaluator')
marker = Path('/tmp/repofixlab-runtime/.ready')
deadline = time.monotonic() + 30
while not marker.is_file():
    if time.monotonic() >= deadline:
        raise SystemExit(70)
    time.sleep(0.05)
entries = []
for path in sorted(root.rglob('*')):
    relative = path.relative_to(root)
    if '__pycache__' in relative.parts or path.suffix == '.pyc':
        continue
    if path.is_symlink():
        raise SystemExit(71)
    if path.is_file():
        content = path.read_bytes()
        entries.append({'path': relative.as_posix(), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
canonical = (json.dumps({'files': entries}, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
actual = hashlib.sha256(canonical).hexdigest()
expected = os.environ.get('REPOFIXLAB_EVALUATOR_KERNEL_SHA256')
if actual != expected or marker.read_text(encoding='ascii').strip() != expected:
    raise SystemExit(72)
environment = dict(os.environ)
environment['PYTHONPATH'] = '/tmp/repofixlab-runtime'
arguments = sys.argv[1:]
if arguments and arguments[0] == 'm6-candidate-patch':
    os.execvpe('python3', ['python3', '-m', 'repofixlab_evaluator.m6_candidate_patch', *arguments[1:]], environment)
os.execvpe('python3', ['python3', '-m', 'repofixlab_evaluator', *arguments], environment)
""".strip()


class RuntimeDockerError(RuntimeError):
    """The production Docker runtime violated a trusted server-side policy."""


@dataclass(frozen=True)
class RuntimeTaskEnvironmentLock:
    lock_id: str
    seal_sha256: str
    instance_id: str
    candidate_id: str
    candidate_sha256: str


@dataclass(frozen=True)
class RuntimePrivateTaskBinding:
    volume_name: str
    task_path: str
    task_bytes: int
    task_sha256: str


@dataclass(frozen=True)
class RuntimePreparedM6Task:
    private_volume: object
    kernel_volume: object
    strict_spec_sha256: str
    repo: str


@dataclass(frozen=True)
class RuntimeDockerConfiguration:
    task_environment_lock_path: Path
    task_environment_lock_schema_path: Path
    dataset_lock_path: Path
    dataset_lock_schema_path: Path
    evaluator_kernel_root: Path
    evaluator_kernel_sha256: str
    runtime_lock_root: Path | None = None


@dataclass
class DockerRuntimeWorker:
    attempt_id: str
    candidate: TrustedCandidate
    container: object
    volumes: tuple[object, ...]
    labels: Mapping[str, str]


@dataclass
class DockerRuntimeJob:
    attempt_id: str
    run_id: str
    job_id: str
    evaluation_id: str
    candidate: TrustedCandidate
    container: object
    volumes: tuple[object, ...]
    labels: Mapping[str, str]
    evidence_volume: object | None = None
    prepared_m6_task: RuntimePreparedM6Task | None = None
    m6_finalized: bool = False
    artifacts: dict[str, bytes] | None = field(default=None)


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _m6_json_output(raw: bytes, label: str) -> Mapping[str, object]:
    if len(raw) > 256 * 1024:
        raise RuntimeDockerError(f"{label} output exceeds the M6 limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeDockerError(f"{label} output is malformed") from error
    if not isinstance(value, Mapping):
        raise RuntimeDockerError(f"{label} output root is malformed")
    return value


def _strict_json(path: Path, maximum_bytes: int) -> Mapping[str, object]:
    if (
        not path.is_absolute()
        or path.is_symlink()
        or not path.is_file()
        or path.stat().st_size > maximum_bytes
    ):
        raise RuntimeDockerError("trusted runtime JSON path violates policy")

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for name, item in pairs:
            if name in value:
                raise RuntimeDockerError("trusted runtime JSON contains a duplicate key")
            value[name] = item
        return value

    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                RuntimeDockerError("trusted runtime JSON contains a non-finite value")
            ),
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeDockerError("trusted runtime JSON is unreadable") from error
    if not isinstance(value, Mapping):
        raise RuntimeDockerError("trusted runtime JSON root is malformed")
    return value


def load_runtime_task_environment_lock(
    configuration: RuntimeDockerConfiguration,
    catalog: TrustedCandidateCatalog,
    *,
    read_only_check: Callable[[Path], bool],
    lock_path: Path | None = None,
) -> RuntimeTaskEnvironmentLock:
    task_lock_path = lock_path or configuration.task_environment_lock_path
    if not read_only_check(task_lock_path):
        raise RuntimeDockerError("TaskEnvironmentLock is not read-only")
    value = _strict_json(task_lock_path, 128 * 1024)
    schema = _strict_json(configuration.task_environment_lock_schema_path, 256 * 1024)
    Draft202012Validator.check_schema(dict(schema))
    errors = tuple(Draft202012Validator(dict(schema)).iter_errors(value))
    if errors:
        raise RuntimeDockerError("TaskEnvironmentLock does not satisfy its schema")
    semantic = dict(value)
    semantic.pop("lock_id", None)
    semantic.pop("seal_sha256", None)
    semantic.pop("created_at", None)
    verification = semantic.get("verification")
    if not isinstance(verification, Mapping):
        raise RuntimeDockerError("TaskEnvironmentLock verification is malformed")
    stable_verification = dict(verification)
    stable_verification.pop("completed_at", None)
    semantic["verification"] = stable_verification
    seal_sha256 = value.get("seal_sha256")
    lock_id = value.get("lock_id")
    instance_id = value.get("instance_id")
    if (
        not isinstance(seal_sha256, str)
        or seal_sha256 != _canonical_sha256(semantic)
        or not isinstance(lock_id, str)
        or not isinstance(instance_id, str)
        or lock_id != _task_environment_lock_id(instance_id, seal_sha256)
    ):
        raise RuntimeDockerError("TaskEnvironmentLock semantic seal is invalid")
    candidate_id = value.get("candidate_id")
    if not isinstance(candidate_id, str):
        raise RuntimeDockerError("TaskEnvironmentLock candidate is malformed")
    try:
        candidate = catalog.candidate(candidate_id)
    except Exception as error:
        raise RuntimeDockerError("TaskEnvironmentLock candidate is not trusted") from error
    worker_image = value.get("worker_image")
    evaluator_image = value.get("evaluator_image")
    resource_profile = value.get("resource_profile")
    if not all(
        isinstance(item, Mapping)
        for item in (worker_image, evaluator_image, resource_profile)
    ):
        raise RuntimeDockerError("TaskEnvironmentLock role bindings are malformed")
    worker_policy = candidate.definition.worker
    evaluator_policy = candidate.definition.evaluator
    assert isinstance(worker_image, Mapping)
    assert isinstance(evaluator_image, Mapping)
    assert isinstance(resource_profile, Mapping)
    if (
        value.get("instance_id") != candidate.instance_id
        or value.get("candidate_sha256") != candidate.candidate_sha256
        or value.get("dataset_lock_id") != candidate.dataset_lock_id
        or value.get("official_image_source_lock_id")
        != candidate.official_image_source_lock_id
        or value.get("filesystem_profile_sha256")
        != candidate.filesystem_profile_sha256
        or value.get("sanitizer_sha256") != candidate.sanitizer_sha256
        or value.get("adapter_sha256") != candidate.adapter_sha256
        or worker_image.get("local_image_id") != worker_policy.image_id
        or worker_image.get("provenance_sha256")
        != worker_policy.provenance_sha256
        or evaluator_image.get("local_image_id") != evaluator_policy.image_id
        or evaluator_image.get("provenance_sha256")
        != evaluator_policy.provenance_sha256
        or worker_image.get("platform") != "linux/amd64"
        or evaluator_image.get("platform") != "linux/amd64"
        or resource_profile.get("cpu_count")
        != worker_policy.nano_cpus / 1_000_000_000
        or resource_profile.get("memory_bytes") != worker_policy.memory_bytes
        or resource_profile.get("pids_limit") != worker_policy.pids_limit
        or resource_profile.get("network_mode") != "none"
        or resource_profile.get("read_only_root_filesystem") is not True
        or worker_policy.nano_cpus != evaluator_policy.nano_cpus
        or worker_policy.memory_bytes != evaluator_policy.memory_bytes
        or worker_policy.pids_limit != evaluator_policy.pids_limit
    ):
        raise RuntimeDockerError("TaskEnvironmentLock trusted bindings drifted")
    return RuntimeTaskEnvironmentLock(
        lock_id=lock_id,
        seal_sha256=seal_sha256,
        instance_id=candidate.instance_id,
        candidate_id=candidate.candidate_id,
        candidate_sha256=candidate.candidate_sha256,
    )


def validate_runtime_dataset_lock(
    configuration: RuntimeDockerConfiguration,
    candidate: TrustedCandidate,
    *,
    read_only_check: Callable[[Path], bool],
    dataset_lock_path: Path | None = None,
) -> RuntimePrivateTaskBinding:
    path = dataset_lock_path or configuration.dataset_lock_path
    if not read_only_check(path):
        raise RuntimeDockerError("DatasetLock is not read-only")
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise RuntimeDockerError("DatasetLock is unreadable") from error
    if len(raw) > 1024 * 1024:
        raise RuntimeDockerError("DatasetLock exceeds the fixed size limit")
    value = _strict_json(path, 1024 * 1024)
    schema = _strict_json(configuration.dataset_lock_schema_path, 256 * 1024)
    Draft202012Validator.check_schema(dict(schema))
    if tuple(Draft202012Validator(dict(schema)).iter_errors(value)):
        raise RuntimeDockerError("DatasetLock does not satisfy its schema")
    volumes = value.get("volumes")
    files = value.get("files")
    if not isinstance(volumes, Mapping) or not isinstance(files, list):
        raise RuntimeDockerError("DatasetLock runtime bindings are malformed")
    private_task_path = f"tasks/{candidate.instance_id}.json"
    matching = [
        item
        for item in files
        if isinstance(item, Mapping)
        and item.get("scope") == "private"
        and item.get("path") == private_task_path
    ]
    if (
        value.get("lock_id") != candidate.dataset_lock_id
        or hashlib.sha256(raw).hexdigest() != candidate.dataset_lock_sha256
        or len(matching) != 1
    ):
        raise RuntimeDockerError("DatasetLock private task binding drifted")
    private_volume = volumes.get("private")
    task_bytes = matching[0].get("bytes")
    task_sha256 = matching[0].get("sha256")
    if (
        not isinstance(private_volume, str)
        or _VOLUME_NAME.fullmatch(private_volume) is None
        or isinstance(task_bytes, bool)
        or not isinstance(task_bytes, int)
        or task_bytes < 1
        or not isinstance(task_sha256, str)
        or _SHA256.fullmatch(task_sha256) is None
    ):
        raise RuntimeDockerError("DatasetLock private task descriptor is malformed")
    return RuntimePrivateTaskBinding(
        volume_name=private_volume,
        task_path=private_task_path,
        task_bytes=task_bytes,
        task_sha256=task_sha256,
    )


def runtime_task_lock_paths(
    configuration: RuntimeDockerConfiguration,
    instance_id: str,
    *,
    read_only_check: Callable[[Path], bool],
) -> tuple[Path, Path]:
    root = configuration.runtime_lock_root
    if root is None:
        return configuration.task_environment_lock_path, configuration.dataset_lock_path
    if (
        not root.is_absolute()
        or root.is_symlink()
        or not root.is_dir()
        or not read_only_check(root)
    ):
        raise RuntimeDockerError("runtime task lock root violates the read-only path policy")
    task_directory = root / _task_environment_lock_directory(instance_id)
    if task_directory.is_symlink() or not task_directory.is_dir() or not read_only_check(task_directory):
        raise RuntimeDockerError("runtime task lock directory violates the read-only path policy")
    shared_dataset_lock = root / "dataset-lock.json"
    if shared_dataset_lock.is_file() and not shared_dataset_lock.is_symlink():
        return task_directory / "task-environment-lock.json", shared_dataset_lock
    return task_directory / "task-environment-lock.json", task_directory / "dataset-lock.json"


def _kernel_entries(root: Path) -> tuple[list[dict[str, object]], int]:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise RuntimeDockerError("evaluator kernel root violates path policy")
    resolved = root.resolve(strict=True)
    entries: list[dict[str, object]] = []
    total = 0
    for path in sorted(resolved.rglob("*")):
        relative = path.relative_to(resolved)
        if "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise RuntimeDockerError("evaluator kernel contains a symbolic link")
        if not path.is_file():
            continue
        content = path.read_bytes()
        total += len(content)
        entries.append(
            {
                "path": relative.as_posix(),
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    if not entries or len(entries) > _KERNEL_FILE_LIMIT or total > _KERNEL_LIMIT_BYTES:
        raise RuntimeDockerError("evaluator kernel exceeds the fixed policy")
    return entries, total


def evaluator_kernel_aggregate(root: Path) -> str:
    entries, _total = _kernel_entries(root)
    return _canonical_sha256({"files": entries})


def _tar_bytes(files: Mapping[str, bytes]) -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        directories: set[str] = set()
        for name in sorted(files):
            pure = PurePosixPath(name)
            if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
                raise RuntimeDockerError("runtime archive path is malformed")
            current = PurePosixPath()
            for part in pure.parts[:-1]:
                current /= part
                directories.add(current.as_posix())
        for name in sorted(directories):
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o555
            info.mtime = 0
            archive.addfile(info)
        for name, content in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o444
            info.mtime = 0
            archive.addfile(info, io.BytesIO(content))
    value = stream.getvalue()
    if len(value) > _ARCHIVE_LIMIT_BYTES:
        raise RuntimeDockerError("runtime archive exceeds the fixed policy")
    return value


def _kernel_material(root: Path, aggregate_sha256: str) -> Mapping[str, bytes]:
    entries, _total = _kernel_entries(root)
    files = {
        f"repofixlab-runtime/repofixlab_evaluator/{entry['path']}": (
            root / str(entry["path"])
        ).read_bytes()
        for entry in entries
    }
    files["repofixlab-runtime/.ready.pending"] = (
        f"{aggregate_sha256}\n".encode("ascii")
    )
    return MappingProxyType(files)


def _worker_helper_material() -> tuple[Mapping[str, bytes], str]:
    root = Path(__file__).resolve().parent
    names = ("runtime_tools.py", "runtime_worker_entry.py")
    files: dict[str, bytes] = {}
    entries: list[dict[str, object]] = []
    for name in names:
        content = (root / name).read_bytes()
        files[f"repofixlab-runtime-worker/{name}"] = content
        entries.append(
            {
                "path": name,
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    return MappingProxyType(files), _canonical_sha256({"files": entries})


def _labels(attempt_id: str, candidate_id: str, role: str) -> Mapping[str, str]:
    if _IDENTIFIER.fullmatch(attempt_id) is None:
        raise RuntimeDockerError("runtime attempt ID is malformed")
    return MappingProxyType(
        {
            _MANAGED_LABEL: "true",
            _ATTEMPT_LABEL: attempt_id,
            _CANDIDATE_LABEL: candidate_id,
            _ROLE_LABEL: role,
        }
    )


def _filters(attempt_id: str) -> Mapping[str, object]:
    return {
        "label": [
            f"{_MANAGED_LABEL}=true",
            f"{_ATTEMPT_LABEL}={attempt_id}",
        ]
    }


def runtime_path_is_read_only(path: Path) -> bool:
    try:
        return bool(os.statvfs(path).f_flag & os.ST_RDONLY)
    except OSError as error:
        raise RuntimeDockerError("trusted runtime mount flags are unavailable") from error


class DockerRuntimeBackend:
    def __init__(
        self,
        client: DockerClientProtocol,
        catalog: TrustedCandidateCatalog,
        configuration: RuntimeDockerConfiguration,
        *,
        read_only_check: Callable[[Path], bool] = runtime_path_is_read_only,
    ) -> None:
        if _SHA256.fullmatch(configuration.evaluator_kernel_sha256) is None:
            raise RuntimeDockerError("evaluator kernel SHA-256 is malformed")
        aggregate = evaluator_kernel_aggregate(configuration.evaluator_kernel_root)
        if aggregate != configuration.evaluator_kernel_sha256:
            raise RuntimeDockerError("evaluator kernel aggregate drifted")
        validate_candidate_images(client, catalog)
        self._client = client
        self._catalog = catalog
        self._configuration = configuration
        self._kernel_files = _kernel_material(
            configuration.evaluator_kernel_root,
            aggregate,
        )
        self._m6_runtime = (
            configuration.runtime_lock_root is not None
            and configuration.runtime_lock_root.name.startswith("m6-")
        )
        m3_kernel = configuration.evaluator_kernel_root / "m3_task_kernel.py"
        if self._m6_runtime:
            if m3_kernel.is_symlink() or not m3_kernel.is_file():
                raise RuntimeDockerError("M6 runtime is missing the sealed M3 adapter")
            self._m6_adapter_sha256 = hashlib.sha256(m3_kernel.read_bytes()).hexdigest()
            self._m6_kernel_archive = _tar_bytes(
                {
                    path.removeprefix("repofixlab-runtime/"): content
                    for path, content in self._kernel_files.items()
                    if path.startswith("repofixlab-runtime/repofixlab_evaluator/")
                }
            )
        else:
            self._m6_adapter_sha256 = None
            self._m6_kernel_archive = None
        self._worker_files, self._worker_aggregate = _worker_helper_material()
        task_locks: dict[str, RuntimeTaskEnvironmentLock] = {}
        private_task_bindings: dict[str, RuntimePrivateTaskBinding] = {}
        for candidate in catalog.candidates.values():
            if configuration.runtime_lock_root is not None:
                task_directory = configuration.runtime_lock_root / _task_environment_lock_directory(
                    candidate.instance_id
                )
                # One Controller catalog can hold immutable candidates from
                # multiple protocol generations. A versioned runtime root
                # selects its own task set; an absent directory is not an
                # implicit fallback to another generation.
                if not task_directory.exists():
                    continue
            task_lock_path, dataset_lock_path = runtime_task_lock_paths(
                configuration,
                candidate.instance_id,
                read_only_check=read_only_check,
            )
            task_lock = load_runtime_task_environment_lock(
                configuration,
                catalog,
                read_only_check=read_only_check,
                lock_path=task_lock_path,
            )
            if task_lock.candidate_id != candidate.candidate_id:
                if configuration.runtime_lock_root is not None:
                    # The same instance may occur in an older candidate that
                    # remains available for evidence replay. It is not part of
                    # this root unless the sealed candidate ID matches.
                    continue
                raise RuntimeDockerError("runtime task lock catalog coverage is incomplete")
            task_locks[candidate.candidate_id] = task_lock
            private_task_bindings[candidate.candidate_id] = validate_runtime_dataset_lock(
                configuration,
                candidate,
                read_only_check=read_only_check,
                dataset_lock_path=dataset_lock_path,
            )
        if not task_locks:
            raise RuntimeDockerError("runtime task lock root does not bind any trusted candidate")
        self._task_locks = MappingProxyType(task_locks)
        self._private_task_bindings = MappingProxyType(private_task_bindings)
        for binding in self._private_task_bindings.values():
            self._require_private_volume(binding.volume_name)

    def preflight(
        self, candidate_id: str, instance_id: str
    ) -> RuntimePreflightManifest:
        candidate = self._candidate(candidate_id, instance_id)
        task_lock = self._task_locks[candidate.candidate_id]
        private_task = self._private_task_bindings[candidate.candidate_id]
        self._validate_local_images()
        policy = {
            "schema_version": "v1",
            "candidate_sha256": candidate.candidate_sha256,
            "task_environment_lock_sha256": task_lock.seal_sha256,
            "worker_image_id": candidate.definition.worker.image_id,
            "evaluator_image_id": candidate.definition.evaluator.image_id,
            "worker_resources": _resource_identity(candidate.definition.worker),
            "evaluator_resources": _resource_identity(candidate.definition.evaluator),
            "worker_helper_sha256": self._worker_aggregate,
            "evaluator_kernel_sha256": self._configuration.evaluator_kernel_sha256,
            "private_task_sha256": private_task.task_sha256,
            "tools": list(RUNTIME_TOOL_NAMES),
        }
        policy_sha256 = _canonical_sha256(policy)
        return RuntimePreflightManifest(
            manifest_id=f"runtime-manifest-v1-{policy_sha256[:32]}",
            candidate_id=candidate.candidate_id,
            instance_id=candidate.instance_id,
            policy_sha256=policy_sha256,
            task_environment_lock_id=task_lock.lock_id,
            task_environment_lock_sha256=task_lock.seal_sha256,
            candidate_sha256=candidate.candidate_sha256,
            base_commit=candidate.base_commit,
        )

    def prepare_worker(
        self, attempt_id: str, candidate_id: str, instance_id: str
    ) -> object:
        candidate = self._candidate(candidate_id, instance_id)
        self._validate_local_images()
        labels = _labels(attempt_id, candidate_id, "worker")
        volumes: list[object] = []
        container: object | None = None
        try:
            volume_bindings: dict[str, dict[str, str]] = {}
            for mount in candidate.definition.worker.managed_volumes:
                volume = self._create_volume(
                    _resource_name(attempt_id, "worker", mount.key), labels
                )
                volumes.append(volume)
                volume_bindings[_volume_name(volume)] = {
                    "bind": mount.target,
                    "mode": "rw",
                }
            container = self._run_container(
                candidate.definition.worker,
                name=_resource_name(attempt_id, "worker", "container"),
                labels=labels,
                volumes=volume_bindings,
                command=["-c", _KEEPALIVE_SCRIPT],
                entrypoint=["python3"],
                environment={},
            )
            worker_roots = _policy_writable_roots(candidate.definition.worker)
            for relative, content in self._worker_files.items():
                _inject_file(
                    container,
                    f"/tmp/{relative}",
                    content,
                    user=candidate.definition.worker.user,
                    writable_roots=worker_roots,
                )
            output = self._exec_json(
                container,
                ["python3", _WORKER_ENTRY, "self-check"],
                user=candidate.definition.worker.user,
            )
            if (
                set(output)
                != {"schema_version", "response_type", "aggregate_sha256"}
                or output.get("schema_version") != "v1"
                or output.get("response_type") != "runtime_worker_self_check"
                or output.get("aggregate_sha256") != self._worker_aggregate
            ):
                raise RuntimeDockerError("worker helper self-check drifted")
            worker = DockerRuntimeWorker(
                attempt_id=attempt_id,
                candidate=candidate,
                container=container,
                volumes=tuple(volumes),
                labels=labels,
            )
            readiness = self.execute_tool(worker, "repo_list", {"path": "."})
            if (
                readiness.tool != "repo_list"
                or readiness.exit_code != 0
                or readiness.timed_out
            ):
                raise RuntimeDockerError("worker repository tool readiness probe failed")
            return worker
        except Exception:
            self._remove_resources(container, tuple(volumes), attempt_id)
            raise

    def execute_tool(
        self,
        worker: object,
        tool: RuntimeToolName,
        arguments: Mapping[str, object],
    ) -> RuntimeToolResult:
        handle = _worker_handle(worker)
        encoded = base64.b64encode(
            _canonical_bytes({"tool": tool, "input": dict(arguments)})
        ).decode("ascii")
        output = self._exec_json(
            handle.container,
            ["python3", _WORKER_ENTRY, "tool", encoded],
            user=handle.candidate.definition.worker.user,
            tool_error=True,
        )
        if (
            set(output) != {"schema_version", "response_type", "result"}
            or output.get("schema_version") != "v1"
            or output.get("response_type") != "runtime_worker_tool_result"
        ):
            raise RuntimeDockerError("worker tool response envelope drifted")
        result = output.get("result")
        if not isinstance(result, Mapping):
            raise RuntimeDockerError("worker tool result is malformed")
        return _runtime_tool_result(result, tool, arguments)

    def verification_catalog(self, worker: object) -> RuntimeVerificationCatalog:
        handle = _worker_handle(worker)
        output = self._exec_json(
            handle.container,
            ["python3", _WORKER_ENTRY, "verification-catalog"],
            user=handle.candidate.definition.worker.user,
        )
        if (
            set(output) != {"schema_version", "response_type", "catalog"}
            or output.get("schema_version") != "v1"
            or output.get("response_type") != "runtime_worker_verification_catalog"
        ):
            raise RuntimeDockerError("worker verification catalog envelope drifted")
        catalog = output.get("catalog")
        if not isinstance(catalog, Mapping) or set(catalog) != {"catalog_id", "source_sha256", "entries"}:
            raise RuntimeDockerError("worker verification catalog is malformed")
        catalog_id = catalog.get("catalog_id")
        source_sha256 = catalog.get("source_sha256")
        entries = catalog.get("entries")
        if (
            not isinstance(catalog_id, str)
            or _IDENTIFIER.fullmatch(catalog_id) is None
            or not isinstance(source_sha256, str)
            or _SHA256.fullmatch(source_sha256) is None
            or not isinstance(entries, list)
            or len(entries) > 16
        ):
            raise RuntimeDockerError("worker verification catalog identity is malformed")
        parsed_entries: list[RuntimeVerificationCatalogEntry] = []
        for entry in entries:
            if not isinstance(entry, Mapping) or set(entry) != {"candidate_id", "description"}:
                raise RuntimeDockerError("worker verification catalog entry is malformed")
            candidate_id = entry.get("candidate_id")
            description = entry.get("description")
            if (
                not isinstance(candidate_id, str)
                or _IDENTIFIER.fullmatch(candidate_id) is None
                or not isinstance(description, str)
                or not description
                or len(description) > 512
            ):
                raise RuntimeDockerError("worker verification catalog entry identity is malformed")
            parsed_entries.append(
                RuntimeVerificationCatalogEntry(
                    candidate_id=candidate_id,
                    description=description,
                    argv=(),
                )
            )
        if len({entry.candidate_id for entry in parsed_entries}) != len(parsed_entries):
            raise RuntimeDockerError("worker verification catalog contains duplicate candidates")
        return RuntimeVerificationCatalog(
            catalog_id=catalog_id,
            source_sha256=source_sha256,
            entries=tuple(parsed_entries),
        )

    def verify_catalog_entry(
        self,
        worker: object,
        catalog: RuntimeVerificationCatalog,
        candidate_id: str,
        patch: bytes,
    ) -> RuntimeVerificationResult:
        handle = _worker_handle(worker)
        encoded = base64.b64encode(
            _canonical_bytes(
                {
                    "catalog_id": catalog.catalog_id,
                    "candidate_id": candidate_id,
                    "patch_base64": base64.b64encode(patch).decode("ascii"),
                }
            )
        ).decode("ascii")
        output = self._exec_json(
            handle.container,
            ["python3", _WORKER_ENTRY, "verify", encoded],
            user=handle.candidate.definition.worker.user,
            tool_error=True,
        )
        if (
            set(output) != {"schema_version", "response_type", "result"}
            or output.get("schema_version") != "v1"
            or output.get("response_type") != "runtime_worker_verification_result"
        ):
            raise RuntimeDockerError("worker verification result envelope drifted")
        result = output.get("result")
        if not isinstance(result, Mapping):
            raise RuntimeDockerError("worker verification result is malformed")
        return _runtime_verification_result(result, catalog.catalog_id, candidate_id)

    def snapshot_patch(self, worker: object) -> RuntimeSnapshotEvidence:
        handle = _worker_handle(worker)
        output = self._exec_json(
            handle.container,
            ["python3", _WORKER_ENTRY, "snapshot"],
            user=handle.candidate.definition.worker.user,
        )
        return _snapshot_evidence(output)

    def destroy_worker(self, worker: object) -> RuntimeCleanupResult:
        handle = _worker_handle(worker)
        return self._remove_resources(
            handle.container,
            handle.volumes,
            handle.attempt_id,
        )

    def start_evaluation(
        self,
        attempt_id: str,
        run_id: str,
        job_id: str,
        evaluation_id: str,
        candidate_id: str,
        instance_id: str,
        patch: bytes,
    ) -> object:
        candidate = self._candidate(candidate_id, instance_id)
        if self._m6_runtime:
            return self._start_m6_evaluation(
                attempt_id,
                run_id,
                job_id,
                evaluation_id,
                candidate,
                patch,
            )
        private_task = self._private_task_bindings[candidate.candidate_id]
        for identifier in (run_id, job_id, evaluation_id):
            if _IDENTIFIER.fullmatch(identifier) is None:
                raise RuntimeDockerError("evaluation identity is malformed")
        self._validate_local_images()
        self._require_private_volume(private_task.volume_name)
        labels = _labels(attempt_id, candidate_id, "evaluator")
        created: list[object] = []
        seed: object | None = None
        evaluator: object | None = None
        try:
            workspace = self._create_volume(
                _resource_name(attempt_id, "evaluator", "testbed"), labels
            )
            input_volume = self._create_volume(
                _resource_name(attempt_id, "evaluator", "input"), labels
            )
            evidence = self._create_volume(
                _resource_name(attempt_id, "evaluator", "evidence"), labels
            )
            created.extend((workspace, input_volume, evidence))
            seed = self._run_container(
                candidate.definition.evaluator,
                name=_resource_name(attempt_id, "evaluator", "seed"),
                labels=labels,
                volumes={
                    _volume_name(input_volume): {
                        "bind": _INPUT_ROOT,
                        "mode": "rw",
                    }
                },
                command=["-c", _KEEPALIVE_SCRIPT],
                entrypoint=["python3"],
                environment={},
            )
            patch_path = f"{_INPUT_ROOT}/candidate.patch"
            _inject_file(
                seed,
                patch_path,
                patch,
                user=candidate.definition.evaluator.user,
                writable_roots=(_INPUT_ROOT,),
            )
            staged_hash = _verified_file_identity(
                seed,
                patch_path,
                user=candidate.definition.evaluator.user,
            ).split(":", 1)[1]
            if staged_hash != hashlib.sha256(patch).hexdigest():
                raise RuntimeDockerError("candidate patch staging hash drifted")
            _remove_container(seed)
            seed = None
            evaluator_command = [
                "agent-patch",
                "--private-spec",
                f"{_PRIVATE_ROOT}/{private_task.task_path}",
                "--private-spec-sha256",
                private_task.task_sha256,
                "--private-root",
                _PRIVATE_ROOT,
                "--workspace",
                _WORKSPACE_ROOT,
                "--candidate-root",
                _INPUT_ROOT,
                "--candidate-patch-sha256",
                hashlib.sha256(patch).hexdigest(),
                "--evidence-root",
                _EVIDENCE_ROOT,
                "--run-id",
                run_id,
                "--attempt-id",
                attempt_id,
                "--job-id",
                job_id,
                "--evaluation-id",
                evaluation_id,
                "--timeout-seconds",
                str(min(candidate.definition.evaluator.timeout_seconds, 300)),
            ]
            evaluator = self._run_container(
                candidate.definition.evaluator,
                name=_resource_name(attempt_id, "evaluator", "container"),
                labels=labels,
                volumes={
                    _volume_name(workspace): {
                        "bind": _WORKSPACE_ROOT,
                        "mode": "rw",
                    },
                    _volume_name(input_volume): {
                        "bind": _INPUT_ROOT,
                        "mode": "ro",
                    },
                    _volume_name(evidence): {
                        "bind": _EVIDENCE_ROOT,
                        "mode": "rw",
                    },
                    private_task.volume_name: {
                        "bind": _PRIVATE_ROOT,
                        "mode": "ro",
                    },
                },
                command=["-c", _EVALUATOR_WAIT_SCRIPT, *evaluator_command],
                entrypoint=["python3"],
                environment={
                    "REPOFIXLAB_EVALUATOR_KERNEL_SHA256": (
                        self._configuration.evaluator_kernel_sha256
                    )
                },
            )
            evaluator_roots = _policy_writable_roots(
                candidate.definition.evaluator
            )
            for relative, content in self._kernel_files.items():
                _inject_file(
                    evaluator,
                    f"/tmp/{relative}",
                    content,
                    user=candidate.definition.evaluator.user,
                    writable_roots=evaluator_roots,
                )
            _publish_ready_marker(
                evaluator,
                f"{_EVALUATOR_KERNEL_ROOT}/.ready.pending",
                f"{_EVALUATOR_KERNEL_ROOT}/.ready",
                f"{self._configuration.evaluator_kernel_sha256}\n".encode(
                    "ascii"
                ),
                user=candidate.definition.evaluator.user,
                writable_roots=evaluator_roots,
            )
            return DockerRuntimeJob(
                attempt_id=attempt_id,
                run_id=run_id,
                job_id=job_id,
                evaluation_id=evaluation_id,
                candidate=candidate,
                container=evaluator,
                volumes=tuple(created),
                labels=labels,
            )
        except Exception:
            if seed is not None:
                try:
                    _remove_container(seed)
                except Exception:
                    pass
            self._remove_resources(evaluator, tuple(created), attempt_id)
            raise

    def _m6_repository(self, instance_id: str) -> str:
        owner, separator, _task = instance_id.partition("__")
        repositories = {
            "axios": "axios/axios",
            "immutable-js": "immutable-js/immutable-js",
            "mrdoob": "mrdoob/three.js",
            "preactjs": "preactjs/preact",
        }
        repository = repositories.get(owner) if separator else None
        if repository is None:
            raise RuntimeDockerError("M6 instance is outside the frozen repository population")
        return repository

    def _run_m6_pristine(
        self,
        command: list[str],
        *,
        entrypoint: list[str],
        name: str,
        labels: Mapping[str, str],
        volumes: Mapping[str, object],
        user: str,
        cap_add: tuple[str, ...] = (),
    ) -> object:
        container = self._client.containers.run(
            _M6_PRISTINE_IMAGE,
            command,
            entrypoint=entrypoint,
            name=name,
            detach=True,
            remove=False,
            auto_remove=False,
            platform="linux/amd64",
            network_mode="none",
            read_only=True,
            cap_drop=["ALL"],
            cap_add=list(cap_add),
            security_opt=["no-new-privileges:true"],
            privileged=False,
            devices=[],
            ports={},
            tty=False,
            stdin_open=False,
            user=user,
            nano_cpus=2_000_000_000,
            mem_limit="4g",
            memswap_limit="4g",
            pids_limit=256,
            volumes=dict(volumes),
            tmpfs={"/tmp": "rw,noexec,nosuid,size=64m"},
            environment={"PYTHONPATH": f"{_M6_KERNEL_ROOT}:/opt/upstream"},
            labels=dict(labels),
        )
        container_id = getattr(container, "id", None)
        if not isinstance(container_id, str) or _CONTAINER_ID.fullmatch(container_id) is None:
            raise RuntimeDockerError("M6 pristine container ID is malformed")
        return container

    def _create_m6_kernel_volume(
        self,
        attempt_id: str,
        labels: Mapping[str, str],
    ) -> object:
        if self._m6_kernel_archive is None:
            raise RuntimeDockerError("M6 kernel archive is unavailable")
        volume = self._create_volume(
            _resource_name(attempt_id, "m6", "kernel"), labels
        )
        initializer = self._client.containers.create(
            _M6_PRISTINE_IMAGE,
            ["-c", "sleep 30"],
            entrypoint=["/bin/sh"],
            volumes={_volume_name(volume): {"bind": _M6_KERNEL_ROOT, "mode": "rw"}},
            labels=dict(labels),
        )
        try:
            if not initializer.put_archive(_M6_KERNEL_ROOT, self._m6_kernel_archive):
                raise RuntimeDockerError("Controller could not inject the M6 evaluator kernel")
        finally:
            _remove_container(initializer)
        return volume

    def _prepare_m6_task(
        self,
        attempt_id: str,
        candidate: TrustedCandidate,
        private_task: RuntimePrivateTaskBinding,
        labels: Mapping[str, str],
    ) -> RuntimePreparedM6Task:
        if candidate.adapter_sha256 != self._m6_adapter_sha256:
            raise RuntimeDockerError("M6 sealed M3 adapter hash drifted")
        self._require_private_volume(private_task.volume_name)
        kernel_volume = self._create_m6_kernel_volume(attempt_id, labels)
        prepared_volume: object | None = None
        try:
            prepared_volume = self._create_volume(
                _resource_name(attempt_id, "m6", "private"), labels
            )
            permissions = self._run_m6_pristine(
                ["-c", "chmod 700 /work && chown 65532:65532 /work"],
                entrypoint=["/bin/sh"],
                name=_resource_name(attempt_id, "m6", "private-permissions"),
                labels=labels,
                volumes={_volume_name(prepared_volume): {"bind": "/work", "mode": "rw"}},
                user="0:0",
                cap_add=("CHOWN",),
            )
            try:
                if permissions.wait(timeout=30).get("StatusCode") != 0:
                    raise RuntimeDockerError("M6 prepared private volume initialization failed")
            finally:
                _remove_container(permissions)
            repository = self._m6_repository(candidate.instance_id)
            preparation = self._run_m6_pristine(
                [
                    "-m", "repofixlab_evaluator.m3_task_kernel", "prepare",
                    "--dataset-task", f"{_M6_DATASET_ROOT}/{private_task.task_path}",
                    "--dataset-root", _M6_DATASET_ROOT,
                    "--output-root", _M6_PREPARED_ROOT,
                    "--expected-task-sha256", private_task.task_sha256,
                    "--instance-id", candidate.instance_id,
                    "--base-commit", candidate.base_commit,
                    "--repo", repository,
                    "--source-root", "/opt/upstream",
                ],
                entrypoint=["python"],
                name=_resource_name(attempt_id, "m6", "prepare"),
                labels=labels,
                volumes={
                    private_task.volume_name: {"bind": _M6_DATASET_ROOT, "mode": "ro"},
                    _volume_name(prepared_volume): {"bind": _M6_PREPARED_ROOT, "mode": "rw"},
                    _volume_name(kernel_volume): {"bind": _M6_KERNEL_ROOT, "mode": "ro"},
                },
                user="65532:65532",
            )
            try:
                if preparation.wait(timeout=120).get("StatusCode") != 0:
                    raise RuntimeDockerError("M6 private task preparation failed")
                report = _m6_json_output(
                    preparation.logs(stdout=True, stderr=False),
                    "M6 private task preparation",
                )
            finally:
                _remove_container(preparation)
            strict_spec_sha256 = report.get("strict_spec_sha256")
            if (
                set(report)
                != {
                    "schema_version", "record_type", "instance_id", "dataset_task_sha256",
                    "strict_spec_sha256", "official_eval_script_sha256",
                }
                or report.get("schema_version") != "v1"
                or report.get("record_type") != "m3_private_task_preparation"
                or report.get("instance_id") != candidate.instance_id
                or report.get("dataset_task_sha256") != private_task.task_sha256
                or not isinstance(strict_spec_sha256, str)
                or _SHA256.fullmatch(strict_spec_sha256) is None
                or not isinstance(report.get("official_eval_script_sha256"), str)
                or _SHA256.fullmatch(str(report["official_eval_script_sha256"])) is None
            ):
                raise RuntimeDockerError("M6 private task preparation report drifted")
            return RuntimePreparedM6Task(
                private_volume=prepared_volume,
                kernel_volume=kernel_volume,
                strict_spec_sha256=strict_spec_sha256,
                repo=repository,
            )
        except Exception:
            if prepared_volume is not None:
                try:
                    prepared_volume.remove(force=True)
                except Exception:
                    pass
            try:
                kernel_volume.remove(force=True)
            except Exception:
                pass
            raise

    def _start_m6_evaluation(
        self,
        attempt_id: str,
        run_id: str,
        job_id: str,
        evaluation_id: str,
        candidate: TrustedCandidate,
        patch: bytes,
    ) -> DockerRuntimeJob:
        for identifier in (run_id, job_id, evaluation_id):
            if _IDENTIFIER.fullmatch(identifier) is None:
                raise RuntimeDockerError("evaluation identity is malformed")
        private_task = self._private_task_bindings[candidate.candidate_id]
        self._validate_local_images()
        labels = _labels(attempt_id, candidate.candidate_id, "evaluator")
        created: list[object] = []
        seed: object | None = None
        evaluator: object | None = None
        try:
            workspace = self._create_volume(
                _resource_name(attempt_id, "evaluator", "testbed"), labels
            )
            input_volume = self._create_volume(
                _resource_name(attempt_id, "evaluator", "input"), labels
            )
            evidence = self._create_volume(
                _resource_name(attempt_id, "evaluator", "evidence"), labels
            )
            created.extend((workspace, input_volume, evidence))
            prepared = self._prepare_m6_task(
                attempt_id, candidate, private_task, labels
            )
            created.extend((prepared.private_volume, prepared.kernel_volume))
            seed = self._run_container(
                candidate.definition.evaluator,
                name=_resource_name(attempt_id, "evaluator", "seed"),
                labels=labels,
                volumes={_volume_name(input_volume): {"bind": _INPUT_ROOT, "mode": "rw"}},
                command=["-c", _KEEPALIVE_SCRIPT],
                entrypoint=["python3"],
                environment={},
            )
            patch_path = f"{_INPUT_ROOT}/candidate.patch"
            _inject_file(
                seed,
                patch_path,
                patch,
                user=candidate.definition.evaluator.user,
                writable_roots=(_INPUT_ROOT,),
            )
            staged_hash = _verified_file_identity(
                seed, patch_path, user=candidate.definition.evaluator.user
            ).split(":", 1)[1]
            if staged_hash != hashlib.sha256(patch).hexdigest():
                raise RuntimeDockerError("M6 candidate patch staging hash drifted")
            _remove_container(seed)
            seed = None
            evaluator_command = [
                "m6-candidate-patch", "execute",
                "--private-spec", f"{_M6_PREPARED_ROOT}/spec.json",
                "--private-root", _M6_PREPARED_ROOT,
                "--workspace", _WORKSPACE_ROOT,
                "--candidate-root", _INPUT_ROOT,
                "--evidence-root", _EVIDENCE_ROOT,
                "--private-spec-sha256", prepared.strict_spec_sha256,
                "--candidate-patch-sha256", hashlib.sha256(patch).hexdigest(),
                "--instance-id", candidate.instance_id,
                "--base-commit", candidate.base_commit,
                "--evaluation-id", evaluation_id,
                "--job-id", job_id,
                "--run-id", run_id,
                "--attempt-id", attempt_id,
                "--timeout-seconds", str(min(candidate.definition.evaluator.timeout_seconds, 300)),
            ]
            evaluator = self._run_container(
                candidate.definition.evaluator,
                name=_resource_name(attempt_id, "evaluator", "container"),
                labels=labels,
                volumes={
                    _volume_name(workspace): {"bind": _WORKSPACE_ROOT, "mode": "rw"},
                    _volume_name(input_volume): {"bind": _INPUT_ROOT, "mode": "ro"},
                    _volume_name(evidence): {"bind": _EVIDENCE_ROOT, "mode": "rw"},
                    _volume_name(prepared.private_volume): {"bind": _M6_PREPARED_ROOT, "mode": "ro"},
                },
                command=["-c", _EVALUATOR_WAIT_SCRIPT, *evaluator_command],
                entrypoint=["python3"],
                environment={"REPOFIXLAB_EVALUATOR_KERNEL_SHA256": self._configuration.evaluator_kernel_sha256},
            )
            evaluator_roots = _policy_writable_roots(candidate.definition.evaluator)
            for relative, content in self._kernel_files.items():
                _inject_file(
                    evaluator,
                    f"/tmp/{relative}",
                    content,
                    user=candidate.definition.evaluator.user,
                    writable_roots=evaluator_roots,
                )
            _publish_ready_marker(
                evaluator,
                f"{_EVALUATOR_KERNEL_ROOT}/.ready.pending",
                f"{_EVALUATOR_KERNEL_ROOT}/.ready",
                f"{self._configuration.evaluator_kernel_sha256}\n".encode("ascii"),
                user=candidate.definition.evaluator.user,
                writable_roots=evaluator_roots,
            )
            return DockerRuntimeJob(
                attempt_id=attempt_id,
                run_id=run_id,
                job_id=job_id,
                evaluation_id=evaluation_id,
                candidate=candidate,
                container=evaluator,
                volumes=tuple(created),
                labels=labels,
                evidence_volume=evidence,
                prepared_m6_task=prepared,
            )
        except Exception:
            if seed is not None:
                try:
                    _remove_container(seed)
                except Exception:
                    pass
            self._remove_resources(evaluator, tuple(created), attempt_id)
            raise

    def _finalize_m6_evaluation(self, handle: DockerRuntimeJob) -> None:
        prepared = handle.prepared_m6_task
        evidence = handle.evidence_volume
        if prepared is None or evidence is None:
            raise RuntimeDockerError("M6 evaluation job lacks sealed finalization inputs")
        finalizer = self._run_m6_pristine(
            [
                "-m", "repofixlab_evaluator.m6_candidate_patch", "finalize",
                "--private-root", _M6_PREPARED_ROOT,
                "--evidence-root", _M6_EVIDENCE_ROOT,
                "--instance-id", handle.candidate.instance_id,
                "--base-commit", handle.candidate.base_commit,
                "--repo", prepared.repo,
                "--source-root", "/opt/upstream",
            ],
            entrypoint=["python"],
            name=_resource_name(handle.attempt_id, "m6", "finalize"),
            labels=handle.labels,
            volumes={
                _volume_name(prepared.private_volume): {"bind": _M6_PREPARED_ROOT, "mode": "ro"},
                _volume_name(evidence): {"bind": _M6_EVIDENCE_ROOT, "mode": "rw"},
                _volume_name(prepared.kernel_volume): {"bind": _M6_KERNEL_ROOT, "mode": "ro"},
            },
            user="0:0",
        )
        try:
            if finalizer.wait(timeout=90).get("StatusCode") != 0:
                raise RuntimeDockerError("M6 pristine official grader failed")
            _m6_json_output(finalizer.logs(stdout=True, stderr=False), "M6 finalizer")
        finally:
            _remove_container(finalizer)
        handle.m6_finalized = True

    def get_job(self, job: object) -> RuntimeJobStatus:
        handle = _job_handle(job)
        _reload(handle.container)
        state = _container_state(handle.container)
        status = state.get("Status")
        if status in {"created", "restarting"}:
            return RuntimeJobStatus("queued", None, None)
        if status in {"running", "paused"}:
            return RuntimeJobStatus("running", None, None)
        if status not in {"exited", "dead"}:
            raise RuntimeDockerError("evaluator container state is malformed")
        exit_code = state.get("ExitCode")
        if isinstance(exit_code, bool) or not isinstance(exit_code, int):
            raise RuntimeDockerError("evaluator exit code is malformed")
        if exit_code != 0:
            return RuntimeJobStatus("failed", False, "evaluator_process_failed")
        if handle.prepared_m6_task is not None and not handle.m6_finalized:
            try:
                self._finalize_m6_evaluation(handle)
            except RuntimeDockerError:
                return RuntimeJobStatus("failed", False, "official_grading_failed")
        artifacts = self.get_artifacts(handle)
        try:
            report = json.loads(artifacts["evaluation.json"].decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeDockerError("evaluation artifact is malformed") from error
        resolved = report.get("resolved") if isinstance(report, Mapping) else None
        if not isinstance(resolved, bool):
            raise RuntimeDockerError("evaluation resolution is malformed")
        return RuntimeJobStatus("completed", resolved, None)

    def get_artifacts(self, job: object) -> Mapping[str, bytes]:
        handle = _job_handle(job)
        if handle.artifacts is None:
            artifacts = {
                name: _read_container_file(
                    handle.container,
                    f"{_EVIDENCE_ROOT}/{name}",
                    _ARTIFACT_LIMIT_BYTES,
                )
                for name in RUNTIME_EVALUATOR_ARTIFACTS
            }
            handle.artifacts = artifacts
        return MappingProxyType(dict(handle.artifacts))

    def acknowledge_artifacts(self, job: object) -> RuntimeCleanupResult:
        handle = _job_handle(job)
        if handle.artifacts is None:
            self.get_artifacts(handle)
        return self._remove_resources(
            handle.container,
            handle.volumes,
            handle.attempt_id,
        )

    def recover_attempt(self, attempt_id: str) -> RuntimeCleanupResult:
        errors: list[str] = []
        try:
            containers = list(
                self._client.containers.list(all=True, filters=_filters(attempt_id))
            )
        except Exception as error:
            containers = []
            errors.append(f"container_list:{type(error).__name__}")
        for container in containers:
            try:
                _remove_container(container)
            except Exception as error:
                errors.append(f"container_remove:{type(error).__name__}")
        try:
            volumes = list(self._client.volumes.list(filters=_filters(attempt_id)))
        except Exception as error:
            volumes = []
            errors.append(f"volume_list:{type(error).__name__}")
        for volume in volumes:
            try:
                volume.remove(force=True)
            except Exception as error:
                errors.append(f"volume_remove:{type(error).__name__}")
        residual_containers, residual_volumes, audit_errors = self._audit(attempt_id)
        errors.extend(audit_errors)
        return RuntimeCleanupResult(
            residual_container_count=residual_containers,
            residual_volume_count=residual_volumes,
            errors=tuple(errors),
        )

    def _candidate(self, candidate_id: str, instance_id: str) -> TrustedCandidate:
        task_lock = self._task_locks.get(candidate_id)
        if task_lock is None:
            raise RuntimeDockerError("runtime candidate is not TaskEnvironmentLock bound")
        candidate = self._catalog.candidate(candidate_id)
        if instance_id != candidate.instance_id or instance_id != task_lock.instance_id:
            raise RuntimeDockerError("runtime instance is not TaskEnvironmentLock bound")
        return candidate

    def _validate_local_images(self) -> None:
        validate_candidate_images(self._client, self._catalog)

    def _require_private_volume(self, volume_name: str) -> object:
        get = getattr(self._client.volumes, "get", None)
        if not callable(get):
            raise RuntimeDockerError("Docker volume lookup is unavailable")
        try:
            volume = get(volume_name)
        except Exception as error:
            raise RuntimeDockerError("trusted private task volume is unavailable") from error
        if _volume_name(volume) != volume_name:
            raise RuntimeDockerError("trusted private task volume identity drifted")
        return volume

    def _create_volume(
        self, name: str, labels: Mapping[str, str]
    ) -> object:
        volume = self._client.volumes.create(name=name, labels=dict(labels))
        if _volume_name(volume) != name:
            raise RuntimeDockerError("Docker volume name drifted")
        return volume

    def _run_container(
        self,
        policy: RoleLaunchPolicy,
        *,
        name: str,
        labels: Mapping[str, str],
        volumes: Mapping[str, object],
        command: list[str],
        entrypoint: list[str],
        environment: Mapping[str, str],
    ) -> object:
        container = self._client.containers.run(
            policy.image_id,
            command,
            entrypoint=entrypoint,
            name=name,
            detach=True,
            remove=False,
            auto_remove=False,
            platform="linux/amd64",
            network_mode="none",
            read_only=True,
            cap_drop=["ALL"],
            cap_add=[],
            security_opt=["no-new-privileges:true"],
            privileged=False,
            devices=[],
            ports={},
            tty=False,
            stdin_open=False,
            user=policy.user,
            nano_cpus=policy.nano_cpus,
            mem_limit=policy.memory_bytes,
            memswap_limit=policy.memory_swap_bytes,
            pids_limit=policy.pids_limit,
            volumes=dict(volumes),
            tmpfs={mount.target: mount.options for mount in policy.tmpfs},
            environment=dict(environment),
            labels=dict(labels),
        )
        container_id = getattr(container, "id", None)
        if not isinstance(container_id, str) or _CONTAINER_ID.fullmatch(container_id) is None:
            raise RuntimeDockerError("Docker container ID is malformed")
        return container

    def _exec_json(
        self,
        container: object,
        command: list[str],
        *,
        user: str,
        tool_error: bool = False,
    ) -> Mapping[str, object]:
        exit_code, stdout, _stderr = _exec(container, command, user=user)
        if exit_code != 0:
            if tool_error and exit_code == 2:
                raise RuntimeToolError("worker tool request was rejected")
            raise RuntimeDockerError("runtime container command failed")
        try:
            value = json.loads(stdout.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeDockerError("runtime container JSON is malformed") from error
        if not isinstance(value, Mapping):
            raise RuntimeDockerError("runtime container JSON root is malformed")
        return value

    def _exec_text(
        self, container: object, command: list[str], *, user: str
    ) -> str:
        return _exec_text_static(container, command, user=user)

    def _remove_resources(
        self,
        container: object | None,
        volumes: tuple[object, ...],
        attempt_id: str,
    ) -> RuntimeCleanupResult:
        errors: list[str] = []
        if container is not None:
            try:
                _remove_container(container)
            except Exception as error:
                errors.append(f"container_remove:{type(error).__name__}")
        for volume in reversed(volumes):
            try:
                volume.remove(force=True)
            except Exception as error:
                errors.append(f"volume_remove:{type(error).__name__}")
        residual_containers, residual_volumes, audit_errors = self._audit(attempt_id)
        errors.extend(audit_errors)
        return RuntimeCleanupResult(
            residual_container_count=residual_containers,
            residual_volume_count=residual_volumes,
            errors=tuple(errors),
        )

    def _audit(self, attempt_id: str) -> tuple[int, int, list[str]]:
        errors: list[str] = []
        try:
            containers = self._client.containers.list(
                all=True, filters=_filters(attempt_id)
            )
            container_count = len(containers)
        except Exception as error:
            container_count = 1
            errors.append(f"container_audit:{type(error).__name__}")
        try:
            volumes = self._client.volumes.list(filters=_filters(attempt_id))
            volume_count = len(volumes)
        except Exception as error:
            volume_count = 1
            errors.append(f"volume_audit:{type(error).__name__}")
        return container_count, volume_count, errors


def _resource_identity(policy: RoleLaunchPolicy) -> Mapping[str, object]:
    return {
        "nano_cpus": policy.nano_cpus,
        "memory_bytes": policy.memory_bytes,
        "memory_swap_bytes": policy.memory_swap_bytes,
        "pids_limit": policy.pids_limit,
        "timeout_seconds": policy.timeout_seconds,
        "user": policy.user,
    }


def _resource_name(attempt_id: str, role: str, kind: str) -> str:
    digest = hashlib.sha256(
        f"{attempt_id}\0{role}\0{kind}".encode("utf-8")
    ).hexdigest()[:24]
    return f"repofixlab-runtime-{role}-{kind}-{digest}"


def _volume_name(volume: object) -> str:
    name = getattr(volume, "name", None)
    if not isinstance(name, str) or _VOLUME_NAME.fullmatch(name) is None:
        raise RuntimeDockerError("Docker volume name is malformed")
    return name


def _policy_writable_roots(policy: RoleLaunchPolicy) -> tuple[str, ...]:
    return tuple(
        sorted(
            {
                *(mount.target for mount in policy.managed_volumes),
                *(mount.target for mount in policy.tmpfs),
            }
        )
    )


def _injection_binding(
    target: str,
    writable_roots: tuple[str, ...],
) -> tuple[str, str]:
    pure_target = PurePosixPath(target)
    if (
        not pure_target.is_absolute()
        or any(part in {"", ".", ".."} for part in pure_target.parts)
    ):
        raise RuntimeDockerError("runtime injection target is malformed")
    matches: list[tuple[str, str]] = []
    for root in writable_roots:
        pure_root = PurePosixPath(root)
        if (
            not pure_root.is_absolute()
            or any(part in {"", ".", ".."} for part in pure_root.parts)
        ):
            raise RuntimeDockerError("runtime writable root is malformed")
        try:
            relative = pure_target.relative_to(pure_root)
        except ValueError:
            continue
        if relative.parts:
            matches.append((pure_root.as_posix(), relative.as_posix()))
    if not matches:
        raise RuntimeDockerError("runtime injection target is outside writable policy")
    return max(matches, key=lambda item: len(item[0]))


def _inject_file(
    container: object,
    target: str,
    content: bytes,
    *,
    user: str,
    writable_roots: tuple[str, ...],
) -> None:
    if not isinstance(content, bytes) or len(content) > _KERNEL_LIMIT_BYTES:
        raise RuntimeDockerError("runtime injected file exceeds policy")
    root, relative = _injection_binding(target, writable_roots)
    expected_sha256 = hashlib.sha256(content).hexdigest()
    execute = getattr(container, "exec_run", None)
    if not callable(execute):
        raise RuntimeDockerError("Docker stdin injection is unavailable")
    result = execute(
        [
            "python3",
            "-c",
            _STDIN_WRITE_SCRIPT,
            root,
            relative,
            str(len(content)),
            expected_sha256,
        ],
        stdout=False,
        stderr=False,
        stdin=True,
        tty=False,
        privileged=False,
        user=user,
        environment={
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/tmp/repofixlab-home",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        },
        workdir=_WORKSPACE_ROOT,
        socket=True,
        demux=False,
    )
    if getattr(result, "exit_code", object()) is not None:
        raise RuntimeDockerError("Docker stdin injection session drifted")
    stream = getattr(result, "output", None)
    transport = getattr(stream, "_sock", stream)
    try:
        sendall = getattr(transport, "sendall", None)
        if callable(sendall):
            sendall(content)
        else:
            write = getattr(stream, "write", None)
            if not callable(write) or write(content) != len(content):
                raise RuntimeDockerError("Docker stdin injection write failed")
            flush = getattr(stream, "flush", None)
            if callable(flush):
                flush()
        shutdown = getattr(transport, "shutdown", None)
        if not callable(shutdown):
            raise RuntimeDockerError("Docker stdin injection cannot signal EOF")
        shutdown(socket.SHUT_WR)
        deadline = monotonic() + 30
        expected_identity = f"{len(content)}:{expected_sha256}"
        while True:
            try:
                observed = _verified_file_identity(
                    container,
                    target,
                    user=user,
                )
            except RuntimeDockerError:
                observed = None
            if observed == expected_identity:
                return
            if monotonic() >= deadline:
                raise RuntimeDockerError(
                    "runtime injected file identity did not converge"
                )
            sleep(0.02)
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            close()


def _verified_file_identity(container: object, path: str, *, user: str) -> str:
    return _exec_text_static(
        container,
        ["python3", "-c", _VERIFY_FILE_SCRIPT, path],
        user=user,
    ).strip()


def _publish_ready_marker(
    container: object,
    source: str,
    target: str,
    content: bytes,
    *,
    user: str,
    writable_roots: tuple[str, ...],
) -> None:
    source_root, _source_relative = _injection_binding(source, writable_roots)
    target_root, _target_relative = _injection_binding(target, writable_roots)
    if source_root != target_root:
        raise RuntimeDockerError("runtime ready marker crosses writable roots")
    expected_sha256 = hashlib.sha256(content).hexdigest()
    observed = _exec_text_static(
        container,
        [
            "python3",
            "-c",
            _PUBLISH_READY_SCRIPT,
            source,
            target,
            str(len(content)),
            expected_sha256,
        ],
        user=user,
    ).strip()
    if observed != expected_sha256:
        raise RuntimeDockerError("runtime ready marker publication drifted")


def _exec(
    container: object,
    command: list[str],
    *,
    user: str,
) -> tuple[int, bytes, bytes]:
    execute = getattr(container, "exec_run", None)
    if not callable(execute):
        raise RuntimeDockerError("Docker exec is unavailable")
    result = execute(
        command,
        stdout=True,
        stderr=True,
        stdin=False,
        tty=False,
        privileged=False,
        user=user,
        environment={
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/tmp/repofixlab-home",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        },
        workdir=_WORKSPACE_ROOT,
        demux=True,
    )
    exit_code = getattr(result, "exit_code", None)
    output = getattr(result, "output", None)
    if isinstance(exit_code, bool) or not isinstance(exit_code, int):
        raise RuntimeDockerError("Docker exec exit code is malformed")
    if not isinstance(output, tuple) or len(output) != 2:
        raise RuntimeDockerError("Docker exec output is malformed")
    stdout = output[0] if isinstance(output[0], bytes) else b""
    stderr = output[1] if isinstance(output[1], bytes) else b""
    return exit_code, stdout, stderr


def _exec_text_static(container: object, command: list[str], *, user: str) -> str:
    exit_code, stdout, _stderr = _exec(container, command, user=user)
    if exit_code != 0:
        raise RuntimeDockerError("runtime container command failed")
    try:
        return stdout.decode("ascii")
    except UnicodeError as error:
        raise RuntimeDockerError("runtime container text is malformed") from error


def _runtime_line_span(value: object) -> RuntimeLineSpan:
    if not isinstance(value, Mapping) or set(value) != {
        "start_line",
        "end_line_exclusive",
    }:
        raise RuntimeDockerError("worker line span drifted")
    start_line = value.get("start_line")
    end_line_exclusive = value.get("end_line_exclusive")
    if (
        isinstance(start_line, bool)
        or not isinstance(start_line, int)
        or start_line < 1
        or isinstance(end_line_exclusive, bool)
        or not isinstance(end_line_exclusive, int)
        or end_line_exclusive < start_line
    ):
        raise RuntimeDockerError("worker line span drifted")
    return RuntimeLineSpan(
        start_line=start_line,
        end_line_exclusive=end_line_exclusive,
    )


def _runtime_read_metadata(
    value: object,
    *,
    expected_path: object,
    stdout: str,
    truncated: bool,
) -> RuntimeReadMetadata:
    expected_keys = {
        "path",
        "returned_range",
        "total_lines",
        "file_sha256",
        "source_sha256",
        "complete",
    }
    if not isinstance(value, Mapping) or set(value) != expected_keys:
        raise RuntimeDockerError("worker repo_read metadata drifted")
    path = value.get("path")
    total_lines = value.get("total_lines")
    file_sha256 = value.get("file_sha256")
    source_sha256 = value.get("source_sha256")
    complete = value.get("complete")
    returned_value = value.get("returned_range")
    returned_range = None if returned_value is None else _runtime_line_span(returned_value)
    stdout_line_count = runtime_text_line_count(stdout)
    actual_source_sha256 = hashlib.sha256(stdout.encode("utf-8")).hexdigest()
    if (
        not isinstance(path, str)
        or path != expected_path
        or isinstance(total_lines, bool)
        or not isinstance(total_lines, int)
        or total_lines < 0
        or not isinstance(file_sha256, str)
        or _SHA256.fullmatch(file_sha256) is None
        or not isinstance(source_sha256, str)
        or source_sha256 != actual_source_sha256
        or not isinstance(complete, bool)
        or (returned_range is None and stdout != "")
        or (returned_range is not None and stdout == "")
        or (total_lines == 0 and returned_range is not None)
        or (
            returned_range is not None
            and (
                returned_range.end_line_exclusive - returned_range.start_line
                != stdout_line_count
                or returned_range.end_line_exclusive > total_lines + 1
            )
        )
    ):
        raise RuntimeDockerError("worker repo_read metadata drifted")
    expected_complete = not truncated and (
        total_lines == 0
        or (
            returned_range is not None
            and returned_range.start_line == 1
            and returned_range.end_line_exclusive == total_lines + 1
        )
    )
    if complete != expected_complete or (complete and file_sha256 != source_sha256):
        raise RuntimeDockerError("worker repo_read completion metadata drifted")
    return RuntimeReadMetadata(
        path=path,
        returned_range=returned_range,
        total_lines=total_lines,
        file_sha256=file_sha256,
        source_sha256=source_sha256,
        complete=complete,
    )


def _runtime_edit_metadata(
    value: object,
    *,
    expected_path: object,
    arguments: Mapping[str, object],
) -> RuntimeEditMetadata:
    expected_keys = {
        "path",
        "edit_kind",
        "before_range",
        "before_total_lines",
        "before_file_sha256",
        "after_range",
        "after_total_lines",
        "after_file_sha256",
        "line_delta",
    }
    if not isinstance(value, Mapping) or set(value) != expected_keys:
        raise RuntimeDockerError("worker repo_edit metadata drifted")
    path = value.get("path")
    edit_kind = value.get("edit_kind")
    after_total_lines = value.get("after_total_lines")
    after_file_sha256 = value.get("after_file_sha256")
    if (
        not isinstance(path, str)
        or path != expected_path
        or isinstance(after_total_lines, bool)
        or not isinstance(after_total_lines, int)
        or after_total_lines < 0
        or not isinstance(after_file_sha256, str)
        or _SHA256.fullmatch(after_file_sha256) is None
    ):
        raise RuntimeDockerError("worker repo_edit metadata drifted")
    after_range = _runtime_line_span(value.get("after_range"))
    if edit_kind == "create":
        content = arguments.get("content")
        if (
            set(arguments) != {"path", "content"}
            or not isinstance(content, str)
            or value.get("before_range") is not None
            or value.get("before_total_lines") is not None
            or value.get("before_file_sha256") is not None
            or value.get("line_delta") is not None
            or after_range.start_line != 1
            or after_range.end_line_exclusive != after_total_lines + 1
            or after_total_lines != runtime_text_line_count(content)
            or after_file_sha256
            != hashlib.sha256(content.encode("utf-8")).hexdigest()
        ):
            raise RuntimeDockerError("worker repo_edit create metadata drifted")
        return RuntimeCreateMetadata(
            path=path,
            edit_kind="create",
            before_range=None,
            before_total_lines=None,
            before_file_sha256=None,
            after_range=after_range,
            after_total_lines=after_total_lines,
            after_file_sha256=after_file_sha256,
            line_delta=None,
        )
    if edit_kind != "replace" or set(arguments) != {"path", "old_text", "new_text"}:
        raise RuntimeDockerError("worker repo_edit metadata drifted")
    before_total_lines = value.get("before_total_lines")
    before_file_sha256 = value.get("before_file_sha256")
    line_delta = value.get("line_delta")
    before_range = _runtime_line_span(value.get("before_range"))
    old_text = arguments.get("old_text")
    new_text = arguments.get("new_text")
    if (
        not isinstance(old_text, str)
        or not old_text
        or not isinstance(new_text, str)
        or isinstance(before_total_lines, bool)
        or not isinstance(before_total_lines, int)
        or before_total_lines < 1
        or not isinstance(before_file_sha256, str)
        or _SHA256.fullmatch(before_file_sha256) is None
        or isinstance(line_delta, bool)
        or not isinstance(line_delta, int)
        or line_delta != after_total_lines - before_total_lines
        or before_range.end_line_exclusive > before_total_lines + 1
        or after_range.end_line_exclusive > after_total_lines + 1
        or before_range.start_line != after_range.start_line
        or before_range.end_line_exclusive - before_range.start_line
        != old_text.count("\n") + (0 if old_text.endswith("\n") else 1)
        or after_range.end_line_exclusive - after_range.start_line
        != (0 if not new_text else new_text.count("\n") + (0 if new_text.endswith("\n") else 1))
    ):
        raise RuntimeDockerError("worker repo_edit replace metadata drifted")
    return RuntimeReplaceMetadata(
        path=path,
        edit_kind="replace",
        before_range=before_range,
        before_total_lines=before_total_lines,
        before_file_sha256=before_file_sha256,
        after_range=after_range,
        after_total_lines=after_total_lines,
        after_file_sha256=after_file_sha256,
        line_delta=line_delta,
    )


def _runtime_tool_result(
    value: Mapping[str, object],
    expected_tool: RuntimeToolName,
    arguments: Mapping[str, object] | None = None,
) -> RuntimeToolResult:
    tool_arguments = {} if arguments is None else arguments
    base_keys = {
        "tool",
        "exit_code",
        "stdout",
        "stderr",
        "truncated",
        "timed_out",
        "duration_ms",
    }
    expected_keys = set(base_keys)
    if expected_tool == "repo_read":
        expected_keys.add("read_metadata")
    elif expected_tool == "repo_edit":
        expected_keys.add("edit_metadata")
    exit_code = value.get("exit_code")
    duration_ms = value.get("duration_ms")
    if (
        set(value) != expected_keys
        or value.get("tool") != expected_tool
        or (
            exit_code is not None
            and (isinstance(exit_code, bool) or not isinstance(exit_code, int))
        )
        or not isinstance(value.get("stdout"), str)
        or not isinstance(value.get("stderr"), str)
        or not isinstance(value.get("truncated"), bool)
        or not isinstance(value.get("timed_out"), bool)
        or isinstance(duration_ms, bool)
        or not isinstance(duration_ms, int)
        or duration_ms < 0
    ):
        raise RuntimeDockerError("worker tool result drifted")
    stdout = str(value["stdout"])
    truncated = bool(value["truncated"])
    read_metadata = (
        _runtime_read_metadata(
            value.get("read_metadata"),
            expected_path=tool_arguments.get("path"),
            stdout=stdout,
            truncated=truncated,
        )
        if expected_tool == "repo_read"
        else None
    )
    edit_metadata = (
        _runtime_edit_metadata(
            value.get("edit_metadata"),
            expected_path=tool_arguments.get("path"),
            arguments=tool_arguments,
        )
        if expected_tool == "repo_edit"
        else None
    )
    return RuntimeToolResult(
        tool=expected_tool,
        exit_code=exit_code,
        stdout=stdout,
        stderr=str(value["stderr"]),
        truncated=truncated,
        timed_out=bool(value["timed_out"]),
        duration_ms=duration_ms,
        read_metadata=read_metadata,
        edit_metadata=edit_metadata,
    )


def _runtime_verification_result(
    value: Mapping[str, object],
    expected_catalog_id: str,
    expected_candidate_id: str,
) -> RuntimeVerificationResult:
    expected_keys = {
        "catalog_id",
        "candidate_id",
        "status",
        "reason_code",
        "safe_hint",
        "exit_code",
        "stdout",
        "stderr",
        "truncated",
        "timed_out",
        "duration_ms",
        "baseline",
    }
    status = value.get("status")
    exit_code = value.get("exit_code")
    duration_ms = value.get("duration_ms")
    reason_code = value.get("reason_code")
    safe_hint = value.get("safe_hint")
    baseline_value = value.get("baseline")
    if (
        set(value) != expected_keys
        or value.get("catalog_id") != expected_catalog_id
        or value.get("candidate_id") != expected_candidate_id
        or status
        not in {
            "passed",
            "test_failed",
            "command_invalid",
            "environment_failure",
            "timed_out",
        }
        or (reason_code is not None and not isinstance(reason_code, str))
        or (safe_hint is not None and not isinstance(safe_hint, str))
        or (
            exit_code is not None
            and (isinstance(exit_code, bool) or not isinstance(exit_code, int))
        )
        or not isinstance(value.get("stdout"), str)
        or not isinstance(value.get("stderr"), str)
        or not isinstance(value.get("truncated"), bool)
        or not isinstance(value.get("timed_out"), bool)
        or isinstance(duration_ms, bool)
        or not isinstance(duration_ms, int)
        or duration_ms < 0
        or not isinstance(baseline_value, Mapping)
    ):
        raise RuntimeDockerError("worker verification result drifted")
    baseline = _runtime_verification_observation(baseline_value)
    return RuntimeVerificationResult(
        catalog_id=expected_catalog_id,
        candidate_id=expected_candidate_id,
        status=status,
        reason_code=reason_code,
        safe_hint=safe_hint,
        exit_code=exit_code,
        stdout=str(value["stdout"]),
        stderr=str(value["stderr"]),
        truncated=bool(value["truncated"]),
        timed_out=bool(value["timed_out"]),
        duration_ms=duration_ms,
        baseline=baseline,
    )


def _runtime_verification_observation(
    value: Mapping[str, object],
) -> RuntimeVerificationObservation:
    expected_keys = {
        "status",
        "reason_code",
        "safe_hint",
        "exit_code",
        "stdout",
        "stderr",
        "truncated",
        "timed_out",
        "duration_ms",
    }
    status = value.get("status")
    exit_code = value.get("exit_code")
    duration_ms = value.get("duration_ms")
    reason_code = value.get("reason_code")
    safe_hint = value.get("safe_hint")
    if (
        set(value) != expected_keys
        or status
        not in {
            "passed",
            "test_failed",
            "command_invalid",
            "environment_failure",
            "timed_out",
        }
        or (reason_code is not None and not isinstance(reason_code, str))
        or (safe_hint is not None and not isinstance(safe_hint, str))
        or (exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)))
        or not isinstance(value.get("stdout"), str)
        or not isinstance(value.get("stderr"), str)
        or not isinstance(value.get("truncated"), bool)
        or not isinstance(value.get("timed_out"), bool)
        or isinstance(duration_ms, bool)
        or not isinstance(duration_ms, int)
        or duration_ms < 0
    ):
        raise RuntimeDockerError("worker verification baseline drifted")
    return RuntimeVerificationObservation(
        status=status,
        reason_code=reason_code,
        safe_hint=safe_hint,
        exit_code=exit_code,
        stdout=str(value["stdout"]),
        stderr=str(value["stderr"]),
        truncated=bool(value["truncated"]),
        timed_out=bool(value["timed_out"]),
        duration_ms=duration_ms,
    )


def _snapshot_evidence(value: Mapping[str, object]) -> RuntimeSnapshotEvidence:
    expected = {
        "schema_version",
        "response_type",
        "patch_base64",
        "base_commit",
        "base_tree",
        "candidate_tree",
        "files",
        "policy",
    }
    files_value = value.get("files")
    policy = value.get("policy")
    if (
        set(value) != expected
        or value.get("schema_version") != "v1"
        or value.get("response_type") != "runtime_worker_snapshot"
        or not isinstance(value.get("patch_base64"), str)
        or not isinstance(value.get("base_commit"), str)
        or not isinstance(value.get("base_tree"), str)
        or not isinstance(value.get("candidate_tree"), str)
        or not isinstance(files_value, list)
        or not isinstance(policy, Mapping)
        or set(policy) != {"status", "violations"}
        or policy.get("status") not in {"pass", "fail"}
        or not isinstance(policy.get("violations"), list)
    ):
        raise RuntimeDockerError("worker snapshot envelope drifted")
    try:
        patch = base64.b64decode(str(value["patch_base64"]), validate=True)
    except ValueError as error:
        raise RuntimeDockerError("worker snapshot patch encoding drifted") from error
    files: list[RuntimeSnapshotFile] = []
    for item in files_value:
        if (
            not isinstance(item, Mapping)
            or set(item) != {"path", "status"}
            or not isinstance(item.get("path"), str)
            or not isinstance(item.get("status"), str)
        ):
            raise RuntimeDockerError("worker snapshot file evidence drifted")
        files.append(RuntimeSnapshotFile(str(item["path"]), str(item["status"])))
    violations = policy["violations"]
    assert isinstance(violations, list)
    if any(not isinstance(item, str) for item in violations):
        raise RuntimeDockerError("worker snapshot policy evidence drifted")
    return RuntimeSnapshotEvidence(
        patch=patch,
        base_commit=str(value["base_commit"]),
        base_tree=str(value["base_tree"]),
        candidate_tree=str(value["candidate_tree"]),
        files=tuple(files),
        policy_violations=tuple(violations),
    )


def _worker_handle(value: object) -> DockerRuntimeWorker:
    if not isinstance(value, DockerRuntimeWorker):
        raise RuntimeDockerError("runtime worker handle is malformed")
    return value


def _job_handle(value: object) -> DockerRuntimeJob:
    if not isinstance(value, DockerRuntimeJob):
        raise RuntimeDockerError("runtime evaluation handle is malformed")
    return value


def _remove_container(container: object) -> None:
    remove = getattr(container, "remove", None)
    if not callable(remove):
        raise RuntimeDockerError("Docker container removal is unavailable")
    remove(force=True)


def _reload(container: object) -> None:
    reload_container = getattr(container, "reload", None)
    if not callable(reload_container):
        raise RuntimeDockerError("Docker container reload is unavailable")
    reload_container()


def _container_state(container: object) -> Mapping[str, object]:
    attrs = getattr(container, "attrs", None)
    state = attrs.get("State") if isinstance(attrs, Mapping) else None
    if not isinstance(state, Mapping):
        raise RuntimeDockerError("Docker container state is unavailable")
    return state


def _read_container_file(
    container: object,
    path: str,
    maximum_bytes: int,
) -> bytes:
    get_archive = getattr(container, "get_archive", None)
    if not callable(get_archive):
        raise RuntimeDockerError("Docker artifact retrieval is unavailable")
    stream, _stat = get_archive(path)
    archive_bytes = b"".join(stream)
    if len(archive_bytes) > maximum_bytes + 1024 * 1024:
        raise RuntimeDockerError("Docker artifact archive exceeds policy")
    try:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:*") as archive:
            members = archive.getmembers()
            if len(members) != 1 or not members[0].isfile():
                raise RuntimeDockerError("Docker artifact archive is malformed")
            extracted = archive.extractfile(members[0])
            if extracted is None:
                raise RuntimeDockerError("Docker artifact archive is empty")
            content = extracted.read(maximum_bytes + 1)
    except tarfile.TarError as error:
        raise RuntimeDockerError("Docker artifact archive is malformed") from error
    if len(content) > maximum_bytes:
        raise RuntimeDockerError("Docker artifact exceeds policy")
    return content
