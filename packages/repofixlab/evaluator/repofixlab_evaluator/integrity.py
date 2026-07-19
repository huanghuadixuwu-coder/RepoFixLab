from __future__ import annotations

from pathlib import Path

from .canonical import canonical_json, sha256_bytes, sha256_file
from .errors import OfficialSourceError


def directory_aggregate(root: Path) -> tuple[str, int, int]:
    resolved_root = root.resolve(strict=True)
    if not resolved_root.is_dir() or root.is_symlink():
        raise OfficialSourceError("integrity root is not a regular directory")
    entries: list[dict[str, object]] = []
    for path in sorted(resolved_root.rglob("*")):
        relative = path.relative_to(resolved_root)
        if "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise OfficialSourceError("integrity root contains a symlink")
        if not path.is_file():
            continue
        entries.append(
            {
                "path": relative.as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(str(path)),
            }
        )
    return (
        sha256_bytes(canonical_json({"files": entries})),
        len(entries),
        sum(int(entry["bytes"]) for entry in entries),
    )
