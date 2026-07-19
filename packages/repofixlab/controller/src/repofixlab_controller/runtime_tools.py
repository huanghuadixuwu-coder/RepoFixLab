from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic_ns
from typing import Literal


RuntimeToolName = Literal[
    "repo_list",
    "repo_read",
    "repo_search",
    "repo_edit",
    "repo_exec",
    "repo_diff",
]

RUNTIME_TOOL_NAMES: tuple[RuntimeToolName, ...] = (
    "repo_list",
    "repo_read",
    "repo_search",
    "repo_edit",
    "repo_exec",
    "repo_diff",
)
TOOL_OUTPUT_LIMIT_BYTES = 64 * 1024
TOOL_INPUT_LIMIT_BYTES = 256 * 1024
TOOL_TIMEOUT_MILLISECONDS = 30_000
TOOL_TIMEOUT_MAX_MILLISECONDS = 120_000
SNAPSHOT_LIMIT_BYTES = 2 * 1024 * 1024
SNAPSHOT_FILE_LIMIT = 100
SNAPSHOT_PATH_LIMIT_BYTES = 512
_GIT_OBJECT_ID = re.compile(r"^[a-f0-9]{40}$")


class RuntimeToolError(RuntimeError):
    """A repository tool request violates the fixed worker policy."""


@dataclass(frozen=True)
class RuntimeToolResult:
    tool: RuntimeToolName
    exit_code: int | None
    stdout: str
    stderr: str
    truncated: bool
    timed_out: bool
    duration_ms: int

    def to_dict(self) -> dict[str, object]:
        return {
            "tool": self.tool,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "truncated": self.truncated,
            "timed_out": self.timed_out,
            "duration_ms": self.duration_ms,
        }


@dataclass(frozen=True)
class RuntimeSnapshotFile:
    path: str
    status: str


@dataclass(frozen=True)
class RuntimeSnapshotEvidence:
    patch: bytes
    base_commit: str
    base_tree: str
    candidate_tree: str
    files: tuple[RuntimeSnapshotFile, ...]
    policy_violations: tuple[str, ...]

    @property
    def policy_status(self) -> str:
        return "pass" if not self.policy_violations else "fail"


class RepositoryToolExecutor:
    def __init__(self, repository_root: Path) -> None:
        if not repository_root.is_absolute():
            raise RuntimeToolError("repository root must be absolute")
        if repository_root.is_symlink() or not repository_root.is_dir():
            raise RuntimeToolError("repository root must be a real directory")
        self.repository_root = repository_root.resolve(strict=True)
        result = self._run_git(("rev-parse", "--show-toplevel"))
        if result.returncode != 0:
            raise RuntimeToolError("repository root is not an exact Git worktree")
        try:
            observed_root = Path(result.stdout.decode("utf-8").strip()).resolve(
                strict=True
            )
        except (UnicodeError, OSError) as error:
            raise RuntimeToolError("repository root inspection failed") from error
        if observed_root != self.repository_root:
            raise RuntimeToolError("repository root is not an exact Git worktree")

    def execute(
        self,
        tool: RuntimeToolName,
        arguments: Mapping[str, object],
    ) -> RuntimeToolResult:
        if tool not in RUNTIME_TOOL_NAMES:
            raise RuntimeToolError("runtime tool is not allowlisted")
        started_ms = monotonic_ns() // 1_000_000
        if tool == "repo_list":
            stdout = self._repo_list(arguments)
            return self._text_result(tool, stdout, started_ms)
        if tool == "repo_read":
            stdout = self._repo_read(arguments)
            return self._text_result(tool, stdout, started_ms)
        if tool == "repo_search":
            stdout = self._repo_search(arguments)
            return self._text_result(tool, stdout, started_ms)
        if tool == "repo_edit":
            stdout = self._repo_edit(arguments)
            return self._text_result(tool, stdout, started_ms)
        if tool == "repo_diff":
            _require_exact_keys(arguments, frozenset())
            patch = self.snapshot_patch()
            return self._bytes_result(tool, 0, patch, b"", False, started_ms)
        return self._repo_exec(arguments, started_ms)

    def snapshot_patch(self) -> bytes:
        return self.snapshot_evidence().patch

    def snapshot_evidence(self) -> RuntimeSnapshotEvidence:
        with TemporaryDirectory(prefix="repofixlab-index-") as temporary:
            index_path = Path(temporary) / "index"
            object_path = Path(temporary) / "objects"
            object_path.mkdir(mode=0o700)
            environment = self._git_environment()
            environment["GIT_INDEX_FILE"] = str(index_path)
            environment["GIT_OBJECT_DIRECTORY"] = str(object_path)
            environment["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = str(
                self.repository_root / ".git" / "objects"
            )
            base_commit = self._git_text(("rev-parse", "HEAD"))
            base_tree = self._git_text(("rev-parse", "HEAD^{tree}"))
            for arguments in (("read-tree", "HEAD"), ("add", "-A")):
                result = self._run_git(arguments, environment=environment)
                if result.returncode != 0:
                    raise RuntimeToolError("temporary Git index preparation failed")
            candidate_tree = self._git_text(
                ("write-tree",), environment=environment
            )
            diff = self._run_git(
                ("diff", "--cached", "--binary", "--full-index", "HEAD"),
                environment=environment,
            )
            if diff.returncode != 0:
                raise RuntimeToolError("temporary Git index diff failed")
            if len(diff.stdout) > SNAPSHOT_LIMIT_BYTES:
                raise RuntimeToolError("candidate patch exceeds the fixed size limit")
            names = self._run_git(
                (
                    "diff",
                    "--cached",
                    "--name-status",
                    "--no-renames",
                    "-z",
                    "HEAD",
                ),
                environment=environment,
            )
            if names.returncode != 0:
                raise RuntimeToolError("temporary Git index file listing failed")
            files = _parse_snapshot_files(names.stdout)
            violations = _snapshot_policy_violations(diff.stdout, files)
            return RuntimeSnapshotEvidence(
                patch=diff.stdout,
                base_commit=base_commit,
                base_tree=base_tree,
                candidate_tree=candidate_tree,
                files=files,
                policy_violations=violations,
            )

    def _repo_list(self, arguments: Mapping[str, object]) -> bytes:
        _require_allowed_keys(arguments, frozenset({"path"}), frozenset())
        relative = _optional_string(arguments, "path", ".")
        target = self._resolve_path(relative, allow_root=True)
        if not target.is_dir():
            raise RuntimeToolError("repo_list path is not a directory")
        rows: list[str] = []
        for child in sorted(target.iterdir(), key=lambda value: value.name):
            if child.is_symlink():
                kind = "symlink"
            elif child.is_dir():
                kind = "directory"
            elif child.is_file():
                kind = "file"
            else:
                kind = "other"
            rows.append(f"{kind}\t{child.name}")
        return ("\n".join(rows) + ("\n" if rows else "")).encode("utf-8")

    def _repo_read(self, arguments: Mapping[str, object]) -> bytes:
        _require_exact_keys(arguments, frozenset({"path"}))
        target = self._resolve_path(_required_string(arguments, "path"))
        if not target.is_file():
            raise RuntimeToolError("repo_read path is not a regular file")
        try:
            content = target.read_bytes()
            content.decode("utf-8", errors="strict")
        except (OSError, UnicodeError) as error:
            raise RuntimeToolError("repo_read requires a readable UTF-8 file") from error
        return content

    def _repo_search(self, arguments: Mapping[str, object]) -> bytes:
        _require_allowed_keys(arguments, frozenset({"query", "path"}), frozenset({"query"}))
        query = _required_string(arguments, "query")
        if len(query.encode("utf-8")) > 1024:
            raise RuntimeToolError("repo_search query exceeds the fixed limit")
        relative = _optional_string(arguments, "path", ".")
        target = self._resolve_path(relative, allow_root=True)
        if not target.is_dir():
            raise RuntimeToolError("repo_search path is not a directory")
        rows: list[str] = []
        for root, directory_names, file_names in os.walk(target, followlinks=False):
            root_path = Path(root)
            directory_names[:] = [
                name
                for name in sorted(directory_names)
                if not (root_path / name).is_symlink()
            ]
            for name in sorted(file_names):
                path = root_path / name
                if path.is_symlink() or not path.is_file():
                    continue
                try:
                    if path.stat().st_size > 1024 * 1024:
                        continue
                    text = path.read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    continue
                relative_path = path.relative_to(self.repository_root).as_posix()
                for line_number, line in enumerate(text.splitlines(), start=1):
                    if query in line:
                        rows.append(f"{relative_path}:{line_number}:{line}")
        return ("\n".join(rows) + ("\n" if rows else "")).encode("utf-8")

    def _repo_edit(self, arguments: Mapping[str, object]) -> bytes:
        if "content" in arguments:
            _require_exact_keys(arguments, frozenset({"path", "content"}))
            content = _required_string(arguments, "content", allow_empty=True)
            if len(content.encode("utf-8")) > TOOL_INPUT_LIMIT_BYTES:
                raise RuntimeToolError("repo_edit content exceeds the fixed limit")
            target = self._resolve_path(
                _required_string(arguments, "path"),
                allow_missing_leaf=True,
            )
            self._assert_candidate_edit_path(target)
            if target.exists():
                raise RuntimeToolError(
                    "repo_edit content creates new files only; existing files require old_text and new_text"
                )
            self._write_text_atomically(target, content)
            return f"created\t{target.relative_to(self.repository_root).as_posix()}\n".encode(
                "utf-8"
            )

        _require_exact_keys(arguments, frozenset({"path", "old_text", "new_text"}))
        old_text = _required_string(arguments, "old_text")
        new_text = _required_string(arguments, "new_text", allow_empty=True)
        if len((old_text + new_text).encode("utf-8")) > TOOL_INPUT_LIMIT_BYTES:
            raise RuntimeToolError("repo_edit replacement exceeds the fixed limit")
        target = self._resolve_path(
            _required_string(arguments, "path"),
            allow_missing_leaf=True,
        )
        self._assert_candidate_edit_path(target)
        if not target.exists() or not target.is_file():
            raise RuntimeToolError("repo_edit replacement path is not a regular existing file")
        try:
            original = target.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise RuntimeToolError("repo_edit replacement file could not be read as UTF-8") from error
        if original.count(old_text) != 1:
            raise RuntimeToolError("repo_edit old_text must occur exactly once in the existing file")
        self._write_text_atomically(
            target,
            original.replace(old_text, new_text, 1),
            mode=target.stat().st_mode & 0o777,
        )
        return f"replaced\t{target.relative_to(self.repository_root).as_posix()}\n".encode(
            "utf-8"
        )

    def _assert_candidate_edit_path(self, target: Path) -> None:
        relative = target.relative_to(self.repository_root)
        if (
            any(component in {"test", "tests"} for component in relative.parts)
            or relative.name.startswith(("test_", "test-"))
        ):
            raise RuntimeToolError(
                "repo_edit test paths are prohibited because the controlled evaluator applies a private test patch"
            )

    def _write_text_atomically(
        self, target: Path, content: str, *, mode: int | None = None
    ) -> None:
        encoded = content.encode("utf-8")
        temporary = target.with_name(f".{target.name}.repofixlab-edit-{os.getpid()}")
        if temporary.exists():
            raise RuntimeToolError("repo_edit temporary path already exists")
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            offset = 0
            while offset < len(encoded):
                written = os.write(descriptor, encoded[offset:])
                if written < 1:
                    raise OSError("short repository edit write")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, target)

    def _repo_exec(
        self,
        arguments: Mapping[str, object],
        started_ms: int,
    ) -> RuntimeToolResult:
        _require_allowed_keys(
            arguments,
            frozenset({"argv", "timeout_ms"}),
            frozenset({"argv"}),
        )
        argv_value = arguments.get("argv")
        if (
            not isinstance(argv_value, list)
            or not argv_value
            or len(argv_value) > 64
            or any(
                not isinstance(value, str)
                or not value
                or "\x00" in value
                or len(value.encode("utf-8")) > 1024
                for value in argv_value
            )
        ):
            raise RuntimeToolError("repo_exec argv is malformed")
        executable = argv_value[0]
        if (
            Path(executable).is_absolute()
            or "/" in executable
            or "\\" in executable
            or executable.startswith("-")
        ):
            raise RuntimeToolError("repo_exec executable must use PATH lookup")
        timeout_value = arguments.get("timeout_ms", TOOL_TIMEOUT_MILLISECONDS)
        if (
            isinstance(timeout_value, bool)
            or not isinstance(timeout_value, int)
            or timeout_value < 1
            or timeout_value > TOOL_TIMEOUT_MAX_MILLISECONDS
        ):
            raise RuntimeToolError("repo_exec timeout is outside the fixed policy")
        try:
            environment = self._git_environment()
            environment["NPM_CONFIG_CACHE"] = "/tmp/repofixlab-npm-cache"
            environment["npm_config_update_notifier"] = "false"
            result = subprocess.run(
                list(argv_value),
                cwd=self.repository_root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_value / 1000,
                check=False,
                shell=False,
            )
            return self._bytes_result(
                "repo_exec",
                result.returncode,
                result.stdout,
                result.stderr,
                False,
                started_ms,
            )
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout if isinstance(error.stdout, bytes) else b""
            stderr = error.stderr if isinstance(error.stderr, bytes) else b""
            return self._bytes_result(
                "repo_exec",
                None,
                stdout,
                stderr,
                True,
                started_ms,
            )
        except OSError as error:
            raise RuntimeToolError("repo_exec process could not be started") from error

    def _resolve_path(
        self,
        value: str,
        *,
        allow_root: bool = False,
        allow_missing_leaf: bool = False,
    ) -> Path:
        if not value or "\x00" in value or "\\" in value:
            raise RuntimeToolError("repository path is malformed")
        pure = PurePosixPath(value)
        if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
            if not (allow_root and value == "."):
                raise RuntimeToolError("repository path must be canonical and relative")
            parts: tuple[str, ...] = ()
        else:
            parts = pure.parts
        current = self.repository_root
        for index, part in enumerate(parts):
            current = current / part
            is_leaf = index == len(parts) - 1
            if not current.exists():
                if allow_missing_leaf and is_leaf:
                    break
                raise RuntimeToolError("repository path does not exist")
            if current.is_symlink():
                raise RuntimeToolError("repository path traverses a symbolic link")
        if current == self.repository_root:
            return current
        try:
            resolved_parent = current.parent.resolve(strict=True)
        except OSError as error:
            raise RuntimeToolError("repository path parent is unavailable") from error
        if (
            resolved_parent != self.repository_root
            and self.repository_root not in resolved_parent.parents
        ):
            raise RuntimeToolError("repository path escapes the fixed worktree")
        return current

    def _text_result(
        self,
        tool: RuntimeToolName,
        stdout: bytes,
        started_ms: int,
    ) -> RuntimeToolResult:
        return self._bytes_result(tool, 0, stdout, b"", False, started_ms)

    def _bytes_result(
        self,
        tool: RuntimeToolName,
        exit_code: int | None,
        stdout: bytes,
        stderr: bytes,
        timed_out: bool,
        started_ms: int,
    ) -> RuntimeToolResult:
        bounded_stdout, bounded_stderr, truncated = _bound_output(stdout, stderr)
        return RuntimeToolResult(
            tool=tool,
            exit_code=exit_code,
            stdout=bounded_stdout.decode("utf-8", errors="replace"),
            stderr=bounded_stderr.decode("utf-8", errors="replace"),
            truncated=truncated,
            timed_out=timed_out,
            duration_ms=max(monotonic_ns() // 1_000_000 - started_ms, 0),
        )

    def _run_git(
        self,
        arguments: Sequence[str],
        *,
        environment: Mapping[str, str] | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["git", "-c", f"safe.directory={self.repository_root.as_posix()}", *arguments],
            cwd=self.repository_root,
            env=dict(environment or self._git_environment()),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=TOOL_TIMEOUT_MILLISECONDS / 1000,
            check=False,
            shell=False,
        )

    def _git_text(
        self,
        arguments: Sequence[str],
        *,
        environment: Mapping[str, str] | None = None,
    ) -> str:
        result = self._run_git(arguments, environment=environment)
        try:
            value = result.stdout.decode("ascii").strip()
        except UnicodeError as error:
            raise RuntimeToolError("Git object identity is malformed") from error
        if result.returncode != 0 or _GIT_OBJECT_ID.fullmatch(value) is None:
            raise RuntimeToolError("Git object identity is malformed")
        return value

    def _git_environment(self) -> dict[str, str]:
        return {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self.repository_root),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
        }


def _bound_output(stdout: bytes, stderr: bytes) -> tuple[bytes, bytes, bool]:
    if len(stdout) + len(stderr) <= TOOL_OUTPUT_LIMIT_BYTES:
        return stdout, stderr, False
    bounded_stdout = stdout[:TOOL_OUTPUT_LIMIT_BYTES]
    remaining = TOOL_OUTPUT_LIMIT_BYTES - len(bounded_stdout)
    return bounded_stdout, stderr[:remaining], True


def _parse_snapshot_files(value: bytes) -> tuple[RuntimeSnapshotFile, ...]:
    try:
        fields = value.decode("utf-8", errors="strict").split("\x00")
    except UnicodeError as error:
        raise RuntimeToolError("snapshot paths are not strict UTF-8") from error
    if fields and fields[-1] == "":
        fields.pop()
    if len(fields) % 2 != 0:
        raise RuntimeToolError("snapshot name-status output is malformed")
    return tuple(
        RuntimeSnapshotFile(path=fields[index + 1], status=fields[index])
        for index in range(0, len(fields), 2)
    )


def _snapshot_policy_violations(
    patch: bytes,
    files: tuple[RuntimeSnapshotFile, ...],
) -> tuple[str, ...]:
    violations: set[str] = set()
    if len(patch) > SNAPSHOT_LIMIT_BYTES:
        violations.add("patch_bytes_exceeded")
    if len(files) > SNAPSHOT_FILE_LIMIT:
        violations.add("changed_file_count_exceeded")
    for file in files:
        pure = PurePosixPath(file.path)
        if (
            not file.path
            or "\\" in file.path
            or pure.is_absolute()
            or pure.as_posix() != file.path
            or any(part in {"", ".", "..", ".git"} for part in pure.parts)
            or len(file.path.encode("utf-8")) > SNAPSHOT_PATH_LIMIT_BYTES
        ):
            violations.add("changed_path_invalid")
        if file.status not in {"A", "D", "M", "T"}:
            violations.add("changed_status_invalid")
    return tuple(sorted(violations))


def _require_exact_keys(
    arguments: Mapping[str, object], expected: frozenset[str]
) -> None:
    if set(arguments) != expected:
        raise RuntimeToolError("runtime tool arguments are not exact")


def _require_allowed_keys(
    arguments: Mapping[str, object],
    allowed: frozenset[str],
    required: frozenset[str],
) -> None:
    if not required.issubset(arguments) or not set(arguments).issubset(allowed):
        raise RuntimeToolError("runtime tool arguments are outside the allowlist")


def _required_string(
    value: Mapping[str, object], name: str, *, allow_empty: bool = False
) -> str:
    item = value.get(name)
    if not isinstance(item, str) or (not allow_empty and not item):
        raise RuntimeToolError(f"runtime tool argument {name} is malformed")
    return item


def _optional_string(value: Mapping[str, object], name: str, default: str) -> str:
    item = value.get(name, default)
    if not isinstance(item, str) or not item:
        raise RuntimeToolError(f"runtime tool argument {name} is malformed")
    return item
