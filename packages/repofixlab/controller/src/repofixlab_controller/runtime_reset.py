"""Restore stopped role volumes from their immutable image filesystem.

The Controller runs this file in a fresh, bounded helper. Task processes have
already exited; mounted destinations are trusted Docker volumes, never host
paths. Tree identities include ignored dependencies, Git internals and caches.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys


def _entry_identity(path: Path, root: Path) -> dict[str, object]:
    """Read complete content and metadata without following symbolic links."""
    observed = path.lstat()
    item = {"path": path.relative_to(root).as_posix(), "mode": observed.st_mode,
            "uid": observed.st_uid, "gid": observed.st_gid}
    if stat.S_ISLNK(observed.st_mode):
        item["target"] = os.readlink(path)
    elif stat.S_ISREG(observed.st_mode):
        content = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                content.update(chunk)
        item.update(bytes=observed.st_size, sha256=content.hexdigest())
    elif not stat.S_ISDIR(observed.st_mode):
        raise ValueError("baseline or restored tree contains a special file")
    item["xattrs"] = {name: os.getxattr(path, name, follow_symlinks=False).hex()
                      for name in sorted(os.listxattr(path, follow_symlinks=False))}
    return item


def tree_identity(root: Path, *, entries: dict[str, dict[str, object]] | None = None) -> dict[str, object]:
    """Hash every entry; optionally retain the trusted restore manifest."""
    digest = hashlib.sha256()
    count = 0
    size = 0
    pending = [root]
    while pending:
        path = pending.pop()
        item = _entry_identity(path, root)
        if stat.S_ISDIR(item["mode"]):
            pending.extend(sorted(path.iterdir(), reverse=True))
        size += item.get("bytes", 0)
        if entries is not None:
            entries[item["path"]] = item
        digest.update((json.dumps(item, sort_keys=True, separators=(",", ":")) + "\n").encode())
        count += 1
    return {"sha256": digest.hexdigest(), "entries": count, "bytes": size}


def _remove_entry(path: Path) -> None:
    """Remove unknown entries, including unreadable directories and special files."""
    if not path.is_symlink() and path.is_dir():
        for directory, _children, _files in os.walk(path, followlinks=False):
            os.chown(directory, os.geteuid(), os.getegid())
            os.chmod(directory, 0o700)
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _restore_directory(source: Path, destination: Path, entries: dict[str, dict[str, object]],
                       source_root: Path, destination_root: Path) -> None:
    """Restore differences; unchanged files keep their verified data and inode."""
    os.chown(destination, os.geteuid(), os.getegid())
    os.chmod(destination, 0o700)
    children = {path.name: path for path in source.iterdir()}
    for path in destination.iterdir():
        if path.name not in children:
            _remove_entry(path)
    for name, path in children.items():
        target = destination / name
        observed = path.lstat()
        if stat.S_ISDIR(observed.st_mode):
            if target.is_symlink() or not target.is_dir():
                _remove_entry(target)
                target.mkdir()
            _restore_directory(path, target, entries, source_root, destination_root)
        else:
            try:
                identical = (_entry_identity(target, destination_root) == entries[path.relative_to(source_root).as_posix()]
                             and (not target.is_file() or target.lstat().st_nlink == 1))
            except (OSError, ValueError):
                identical = False
            if identical:
                continue
            _remove_entry(target)
            shutil.copy2(path, target, follow_symlinks=False)
            os.chown(target, observed.st_uid, observed.st_gid, follow_symlinks=False)
            shutil.copystat(path, target, follow_symlinks=False)
    observed = source.lstat()
    os.chown(destination, observed.st_uid, observed.st_gid)
    shutil.copystat(source, destination, follow_symlinks=False)
    for name in set(os.listxattr(destination)) - set(os.listxattr(source)):
        os.removexattr(destination, name)


def restore_tree(source: Path | None, destination: Path) -> dict[str, object]:
    """Restore all differences and verify the complete immutable tree identity."""
    if destination.is_symlink() or not destination.is_dir():
        raise ValueError("reset destination is not a trusted directory")
    if source is None:
        os.chown(destination, os.geteuid(), os.getegid())
        os.chmod(destination, 0o700)
        for path in destination.iterdir():
            _remove_entry(path)
        if any(destination.iterdir()):
            raise ValueError("reset output volume is not empty")
        return {"empty": True}
    if source.is_symlink() or not source.is_dir():
        raise ValueError("immutable baseline is not a directory")
    entries = {}
    expected = tree_identity(source, entries=entries)
    _restore_directory(source, destination, entries, source, destination)
    actual = tree_identity(destination)
    if actual != expected:
        raise ValueError("restored volume differs from its immutable baseline")
    return {"baseline": expected, "restored": actual}


def main() -> None:
    roots = json.loads(sys.argv[1])
    evidence = []
    for item in roots:
        destination = Path(item["destination"])
        live_verification = item.get("verify_only") and "baseline" in item and destination == Path(item["root"])
        if destination.parent != Path("/reset") and not live_verification:
            raise ValueError("reset destination escapes the fixed mount root")
        source = Path(item["source"]) if item["source"] is not None else None
        if item.get("verify_only"):
            if source is None:
                if any(destination.iterdir()):
                    raise ValueError("idle output volume is contaminated")
                result = {"empty": True}
            else:
                baseline = item["baseline"] if "baseline" in item else tree_identity(source)
                restored = tree_identity(destination)
                if baseline != restored:
                    raise ValueError("idle volume differs from its immutable baseline")
                result = {"baseline": baseline, "restored": restored}
        else:
            result = restore_tree(source, destination)
        evidence.append({"root": item["root"], **result})
    print(json.dumps({"roots": evidence, "verified": True}, sort_keys=True))


if __name__ == "__main__":
    main()
