from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as distribution_version
import os
from pathlib import Path
import platform
import re

from .canonical import canonical_json, sha256_bytes
from .constants import (
    DATASET_NAME,
    DATASET_REVISION,
    DATASET_SOURCE_BYTES,
    DATASET_SOURCE_SHA256,
    EXPECTED_RECORD_COUNT,
    EXPECTED_SOURCE_RECORD_COUNT,
    REQUIRED_INSTANCE_ID,
    SCHEMA_VERSION,
)


EXPECTED_RUNTIME_ID = 65532
EXPECTED_PYARROW_VERSION = "25.0.0"
DATA_DIRECTORIES = {
    "public": Path("/data/public"),
    "control": Path("/data/control"),
    "private": Path("/data/private"),
}
DOCKER_SOCKET_PATHS = (Path("/var/run/docker.sock"), Path("/run/docker.sock"))
SENSITIVE_ENVIRONMENT_NAMES = (
    "ZHIPU_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DOCKER_HOST",
)
_IMAGE_ID = re.compile(r"^sha256:[a-f0-9]{64}$")


def _pyarrow_version() -> str | None:
    try:
        return distribution_version("pyarrow")
    except PackageNotFoundError:
        return None


def _runtime_id(name: str) -> int:
    getter = getattr(os, name, None)
    if getter is None:
        return -1
    value = getter()
    return value if isinstance(value, int) and not isinstance(value, bool) else -1


def _data_directories_exist() -> dict[str, bool]:
    return {name: path.is_dir() for name, path in DATA_DIRECTORIES.items()}


def _docker_socket_paths_present() -> tuple[str, ...]:
    return tuple(str(path) for path in DOCKER_SOCKET_PATHS if os.path.lexists(path))


def _sensitive_environment_names_present() -> tuple[str, ...]:
    return tuple(name for name in SENSITIVE_ENVIRONMENT_NAMES if name in os.environ)


def build_self_check_report() -> dict[str, object]:
    image_id_value = os.environ.get("REPOFIX_PREPARER_IMAGE_ID")
    image_id = image_id_value if image_id_value else None
    uid = _runtime_id("getuid")
    gid = _runtime_id("getgid")
    pyarrow_version = _pyarrow_version()
    data_directories_exist = _data_directories_exist()
    docker_socket_paths_present = _docker_socket_paths_present()
    sensitive_environment_names_present = _sensitive_environment_names_present()

    image_id_bound = image_id is not None and _IMAGE_ID.fullmatch(image_id) is not None
    runtime_user = uid == EXPECTED_RUNTIME_ID and gid == EXPECTED_RUNTIME_ID
    pyarrow_version_matches = pyarrow_version == EXPECTED_PYARROW_VERSION
    docker_socket_absent = not docker_socket_paths_present
    sensitive_environment_absent = not sensitive_environment_names_present

    errors: list[str] = []
    if not image_id_bound:
        errors.append("REPOFIX_PREPARER_IMAGE_ID must be a lowercase sha256 image ID")
    if not runtime_user:
        errors.append("runtime uid and gid must both equal 65532")
    if not pyarrow_version_matches:
        errors.append("pyarrow version must equal 25.0.0")
    missing_directories = [
        name for name, exists in data_directories_exist.items() if not exists
    ]
    if missing_directories:
        errors.append(f"required data directories are missing: {', '.join(missing_directories)}")
    if not docker_socket_absent:
        errors.append(
            "Docker socket paths are present: "
            + ", ".join(docker_socket_paths_present)
        )
    if not sensitive_environment_absent:
        errors.append(
            "sensitive environment variables are visible: "
            + ", ".join(sensitive_environment_names_present)
        )

    all_checks_pass = (
        image_id_bound
        and runtime_user
        and pyarrow_version_matches
        and all(data_directories_exist.values())
        and docker_socket_absent
        and sensitive_environment_absent
    )
    report: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "report_type": "dataset_preparer_self_check",
        "status": "pass" if all_checks_pass and not errors else "fail",
        "image_id": image_id,
        "dataset": {
            "name": DATASET_NAME,
            "revision": DATASET_REVISION,
            "source_sha256": DATASET_SOURCE_SHA256,
            "source_bytes": DATASET_SOURCE_BYTES,
            "expected_source_record_count": EXPECTED_SOURCE_RECORD_COUNT,
            "expected_record_count": EXPECTED_RECORD_COUNT,
            "required_instance_id": REQUIRED_INSTANCE_ID,
        },
        "runtime": {
            "python_version": platform.python_version(),
            "pyarrow_version": pyarrow_version,
            "uid": uid,
            "gid": gid,
        },
        "checks": {
            "image_id_bound": image_id_bound,
            "runtime_user": runtime_user,
            "pyarrow_version": pyarrow_version_matches,
            "data_directories_exist": data_directories_exist,
            "docker_socket_absent": docker_socket_absent,
            "sensitive_environment_absent": sensitive_environment_absent,
        },
        "observations": {
            "docker_socket_paths_present": list(docker_socket_paths_present),
            "sensitive_environment_names_present": list(
                sensitive_environment_names_present
            ),
        },
        "errors": errors,
    }
    report["report_sha256"] = sha256_bytes(canonical_json(report))
    return report
