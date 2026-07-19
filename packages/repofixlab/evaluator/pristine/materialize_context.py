from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

EVALUATOR_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EVALUATOR_ROOT))

from repofixlab_evaluator.canonical import canonical_json, sha256_bytes, sha256_file
from repofixlab_evaluator.integrity import directory_aggregate
from repofixlab_evaluator.official_oracle import load_and_verify_source_lock

BASE_IMAGE = (
    "python:3.11.14-slim-bookworm@"
    "sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d"
)
SOURCE_LOCK_PATH = EVALUATOR_ROOT.parent / "configs" / "harness" / "official-swebench-v4.1.0.json"
DEPENDENCY_LOCK_PATH = Path(__file__).with_name("requirements.lock")
DOCKERFILE_PATH = Path(__file__).with_name("Dockerfile")
KERNEL_PATH = EVALUATOR_ROOT / "repofixlab_evaluator"
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024


def _assert_outside_repo(output: Path, repo_root: Path) -> None:
    resolved_output = output.resolve(strict=False)
    resolved_repo = repo_root.resolve(strict=True)
    try:
        resolved_output.relative_to(resolved_repo)
    except ValueError:
        return
    raise ValueError("pristine build context must be outside the repository")


def _copy_regular(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise ValueError(f"build input is not a regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def _copy_kernel(destination: Path) -> None:
    destination.mkdir(parents=True)
    for source in sorted(KERNEL_PATH.rglob("*")):
        relative = source.relative_to(KERNEL_PATH)
        if "__pycache__" in relative.parts or source.suffix == ".pyc":
            continue
        if source.is_symlink():
            raise ValueError("evaluator kernel contains a symlink")
        if source.is_file():
            _copy_regular(source, destination / relative)


def _safe_member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("source archive contains an unsafe path")
    return path


def _extract_pinned_source(archive_path: Path, destination: Path) -> None:
    if (
        archive_path.is_symlink()
        or not archive_path.is_file()
        or archive_path.stat().st_size > MAX_ARCHIVE_BYTES
    ):
        raise ValueError("source archive violates path or size policy")
    seen: set[str] = set()
    extracted_pyproject = False
    extracted_source = False
    with tarfile.open(archive_path, mode="r:*") as archive:
        for member in archive:
            path = _safe_member_path(member.name)
            selected = path.as_posix() == "pyproject.toml" or path.parts[0] == "swebench"
            if not selected:
                continue
            if member.name in seen:
                raise ValueError("source archive contains duplicate selected paths")
            seen.add(member.name)
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise ValueError("selected source archive member is not a regular file")
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("selected source archive member could not be read")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as handle:
                shutil.copyfileobj(source, handle)
            extracted_pyproject = extracted_pyproject or path.as_posix() == "pyproject.toml"
            extracted_source = extracted_source or path.parts[0] == "swebench"
    if not extracted_pyproject or not extracted_source:
        raise ValueError("source archive is missing pyproject.toml or swebench")


def materialize(
    *,
    source_archive: Path,
    output: Path,
    repo_root: Path,
    base_image: str = BASE_IMAGE,
    dockerfile_path: Path = DOCKERFILE_PATH,
) -> dict[str, object]:
    _assert_outside_repo(output, repo_root)
    if re.fullmatch(r"(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})", base_image) is None:
        raise ValueError("pristine base image is not an exact digest reference")
    if output.exists():
        raise ValueError("pristine build context output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="repofixlab-pristine-context-", dir=output.parent))
    try:
        _copy_regular(dockerfile_path, staging / "Dockerfile")
        _copy_regular(DEPENDENCY_LOCK_PATH, staging / "requirements.lock")
        _copy_regular(SOURCE_LOCK_PATH, staging / "official-source-lock.json")
        _extract_pinned_source(source_archive, staging / "upstream")
        _copy_kernel(staging / "repofixlab_evaluator")
        source_lock = load_and_verify_source_lock(
            staging / "official-source-lock.json",
            staging / "upstream",
        )
        kernel_hash, kernel_files, kernel_bytes = directory_aggregate(staging / "repofixlab_evaluator")
        unsigned: dict[str, object] = {
            "schema_version": "v1",
            "artifact_type": "repofixlab_pristine_harness",
            "platform": "linux/amd64",
            "base_image": base_image,
            "upstream_revision": source_lock["upstream_revision"],
            "upstream_tree_sha1": source_lock["upstream_tree_sha1"],
            "source_archive_sha256": sha256_file(str(source_archive)),
            "source_lock_sha256": source_lock["lock_sha256"],
            "source_aggregate_sha256": source_lock["source_aggregate_sha256"],
            "dependency_lock_sha256": sha256_file(str(staging / "requirements.lock")),
            "evaluator_kernel_aggregate_sha256": kernel_hash,
            "evaluator_kernel_file_count": kernel_files,
            "evaluator_kernel_bytes": kernel_bytes,
            "dockerfile_sha256": sha256_file(str(staging / "Dockerfile")),
        }
        provenance = {
            **unsigned,
            "provenance_sha256": sha256_bytes(canonical_json(unsigned)),
        }
        (staging / "build-provenance.json").write_bytes(canonical_json(provenance))
        os.replace(staging, output)
        return provenance
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize an audited pristine harness build context")
    parser.add_argument("--source-archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--base-image", default=BASE_IMAGE)
    parser.add_argument("--dockerfile", default=DOCKERFILE_PATH, type=Path)
    arguments = parser.parse_args()
    provenance = materialize(
        source_archive=arguments.source_archive,
        output=arguments.output,
        repo_root=arguments.repo_root,
        base_image=arguments.base_image,
        dockerfile_path=arguments.dockerfile,
    )
    sys.stdout.buffer.write(canonical_json(provenance))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
