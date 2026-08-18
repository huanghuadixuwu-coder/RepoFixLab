from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, replace
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
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
_SHELL_INTERPRETERS = frozenset(
    {"sh", "bash", "dash", "zsh", "ksh", "fish", "cmd", "powershell", "pwsh"}
)


class RuntimeToolError(RuntimeError):
    """A repository tool request violates the fixed worker policy."""


def _text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _text_lines(value: str) -> list[str]:
    """Split only on LF so Worker and TypeScript Memory use identical line semantics."""
    if not value:
        return []
    parts = value.split("\n")
    lines = [f"{part}\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def _read_text_exact(path: Path) -> str:
    """Decode UTF-8 without universal-newline rewriting so hashes describe exact text."""
    with path.open("r", encoding="utf-8", newline="") as stream:
        return stream.read()


def runtime_text_line_count(value: str) -> int:
    """Count lines with the shared LF-only repository-text contract."""
    return len(_text_lines(value))


def _text_line_span(value: str, start_offset: int, fragment: str) -> RuntimeLineSpan:
    start_line = value.count("\n", 0, start_offset) + 1
    if not fragment:
        return RuntimeLineSpan(start_line=start_line, end_line_exclusive=start_line)
    touched_lines = fragment.count("\n") + (0 if fragment.endswith("\n") else 1)
    return RuntimeLineSpan(
        start_line=start_line,
        end_line_exclusive=start_line + touched_lines,
    )


VerificationStatus = Literal[
    "passed",
    "test_failed",
    "command_invalid",
    "environment_failure",
    "timed_out",
]


@dataclass(frozen=True)
class RuntimeVerificationCatalogEntry:
    candidate_id: str
    description: str
    argv: tuple[str, ...]
    preparation_argv: tuple[str, ...] | None = None


@dataclass(frozen=True)
class RuntimeVerificationCatalog:
    catalog_id: str
    source_sha256: str
    entries: tuple[RuntimeVerificationCatalogEntry, ...]

    def public_dict(self) -> dict[str, object]:
        return {
            "catalog_id": self.catalog_id,
            "source_sha256": self.source_sha256,
            "entries": [
                {"candidate_id": entry.candidate_id, "description": entry.description}
                for entry in self.entries
            ],
        }


@dataclass(frozen=True)
class RuntimeVerificationObservation:
    status: VerificationStatus
    reason_code: str | None
    safe_hint: str | None
    exit_code: int | None
    stdout: str
    stderr: str
    truncated: bool
    timed_out: bool
    duration_ms: int

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "reason_code": self.reason_code,
            "safe_hint": self.safe_hint,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "truncated": self.truncated,
            "timed_out": self.timed_out,
            "duration_ms": self.duration_ms,
        }


@dataclass(frozen=True)
class RuntimeVerificationResult:
    catalog_id: str
    candidate_id: str
    status: VerificationStatus
    reason_code: str | None
    safe_hint: str | None
    exit_code: int | None
    stdout: str
    stderr: str
    truncated: bool
    timed_out: bool
    duration_ms: int
    baseline: RuntimeVerificationObservation

    def to_dict(self) -> dict[str, object]:
        return {
            "catalog_id": self.catalog_id,
            "candidate_id": self.candidate_id,
            "status": self.status,
            "reason_code": self.reason_code,
            "safe_hint": self.safe_hint,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "truncated": self.truncated,
            "timed_out": self.timed_out,
            "duration_ms": self.duration_ms,
            "baseline": self.baseline.to_dict(),
        }


@dataclass(frozen=True)
class RuntimeLineSpan:
    start_line: int
    end_line_exclusive: int


@dataclass(frozen=True)
class RuntimeReadMetadata:
    path: str
    returned_range: RuntimeLineSpan | None
    total_lines: int
    file_sha256: str
    source_sha256: str
    complete: bool


@dataclass(frozen=True)
class RuntimeCreateMetadata:
    path: str
    edit_kind: Literal["create"]
    before_range: None
    before_total_lines: None
    before_file_sha256: None
    after_range: RuntimeLineSpan
    after_total_lines: int
    after_file_sha256: str
    line_delta: None


@dataclass(frozen=True)
class RuntimeReplaceMetadata:
    path: str
    edit_kind: Literal["replace"]
    before_range: RuntimeLineSpan
    before_total_lines: int
    before_file_sha256: str
    after_range: RuntimeLineSpan
    after_total_lines: int
    after_file_sha256: str
    line_delta: int


RuntimeEditMetadata = RuntimeCreateMetadata | RuntimeReplaceMetadata


@dataclass(frozen=True)
class RuntimeToolResult:
    tool: RuntimeToolName
    exit_code: int | None
    stdout: str
    stderr: str
    truncated: bool
    timed_out: bool
    duration_ms: int
    read_metadata: RuntimeReadMetadata | None = None
    edit_metadata: RuntimeEditMetadata | None = None

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "tool": self.tool,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "truncated": self.truncated,
            "timed_out": self.timed_out,
            "duration_ms": self.duration_ms,
        }
        if self.tool == "repo_read":
            if self.read_metadata is None or self.edit_metadata is not None:
                raise RuntimeToolError("repo_read result metadata is invalid")
            result["read_metadata"] = asdict(self.read_metadata)
        elif self.tool == "repo_edit":
            if self.edit_metadata is None or self.read_metadata is not None:
                raise RuntimeToolError("repo_edit result metadata is invalid")
            result["edit_metadata"] = asdict(self.edit_metadata)
        elif self.read_metadata is not None or self.edit_metadata is not None:
            raise RuntimeToolError("non-file tool result contains file metadata")
        return result


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
            stdout, metadata, output_truncated = self._repo_read(arguments)
            return self._bytes_result(
                tool,
                0,
                stdout,
                b"",
                False,
                started_ms,
                output_truncated=output_truncated,
                read_metadata=metadata,
            )
        if tool == "repo_search":
            stdout = self._repo_search(arguments)
            return self._text_result(tool, stdout, started_ms)
        if tool == "repo_edit":
            stdout, metadata = self._repo_edit(arguments)
            return self._bytes_result(
                tool,
                0,
                stdout,
                b"",
                False,
                started_ms,
                edit_metadata=metadata,
            )
        if tool == "repo_diff":
            _require_exact_keys(arguments, frozenset())
            patch = self.snapshot_patch()
            return self._bytes_result(tool, 0, patch, b"", False, started_ms)
        return self._repo_exec(arguments, started_ms)

    def verification_catalog(self) -> RuntimeVerificationCatalog:
        """Build a Controller-owned test command catalog from package metadata.

        The worker never accepts an Agent-provided argv for controlled
        verification. A catalog may be empty when the candidate has no usable
        npm test script; that is a normal diagnostic outcome, not a policy
        bypass.
        """
        package_path = self.repository_root / "package.json"
        if not package_path.is_file() or package_path.is_symlink():
            return _verification_catalog((), b"missing-package-json")
        try:
            package_bytes = package_path.read_bytes()
            package = json.loads(package_bytes.decode("utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return _verification_catalog((), b"invalid-package-json")
        scripts = package.get("scripts") if isinstance(package, dict) else None
        if not isinstance(scripts, dict):
            return _verification_catalog((), package_bytes)

        # This checks that npm is available and that package metadata is
        # readable without executing a test. It deliberately happens before
        # any model edit and does not make test success part of catalog
        # construction.
        try:
            preflight = subprocess.run(
                ["npm", "run"],
                cwd=self.repository_root,
                env=self._verification_environment(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=TOOL_TIMEOUT_MILLISECONDS / 1000,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return _verification_catalog((), package_bytes)
        if preflight.returncode != 0:
            return _verification_catalog((), package_bytes)

        script_names = [
            name
            for name, value in scripts.items()
            if _verification_script_is_terminating(name, value)
        ]
        ordered_names = sorted(set(script_names), key=lambda value: (value != "test", value))[:16]
        preparation_argv = _verification_preparation_argv(
            self.repository_root, package, scripts
        )
        entries = tuple(
            RuntimeVerificationCatalogEntry(
                candidate_id=(
                    "npm-script-"
                    + hashlib.sha256(name.encode("utf-8")).hexdigest()[:24]
                ),
                description=(
                    f'package.json script "{name}"'
                    if preparation_argv is None
                    else f'package.json script "{name}" after its required build preparation'
                ),
                argv=("npm", "run", name),
                preparation_argv=preparation_argv,
            )
            for name in ordered_names
        )
        return _verification_catalog(entries, package_bytes)

    def verify_catalog_entry(
        self,
        catalog: RuntimeVerificationCatalog,
        candidate_id: str,
        patch: bytes,
    ) -> RuntimeVerificationResult:
        entry = next(
            (value for value in catalog.entries if value.candidate_id == candidate_id),
            None,
        )
        if entry is None:
            return _verification_result(
                catalog.catalog_id,
                candidate_id,
                "command_invalid",
                "catalog_candidate_unknown",
                "Select one of the Controller-provided verification candidates.",
            )

        baseline = self._run_verification_entry(entry, None)
        candidate = self._run_verification_entry(entry, patch)
        return _verification_result_from_observations(
            catalog.catalog_id,
            candidate_id,
            baseline,
            candidate,
        )

    def _run_verification_entry(
        self,
        entry: RuntimeVerificationCatalogEntry,
        patch: bytes | None,
    ) -> RuntimeVerificationObservation:
        started_ms = monotonic_ns() // 1_000_000
        with TemporaryDirectory(prefix="repofixlab-verify-") as temporary:
            worktree = Path(temporary) / "worktree"
            git_config = Path(temporary) / "gitconfig"
            try:
                config_environment = self._verification_environment()
                configured = subprocess.run(
                    [
                        "git",
                        "config",
                        "--file",
                        str(git_config),
                        "--add",
                        "safe.directory",
                        str(self.repository_root / ".git"),
                    ],
                    cwd=temporary,
                    env=config_environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=TOOL_TIMEOUT_MILLISECONDS / 1000,
                    check=False,
                    shell=False,
                )
                if configured.returncode != 0:
                    return _verification_observation(
                        "environment_failure",
                        "verification_git_config_unavailable",
                        "The isolated verification Git configuration could not be prepared.",
                        stdout=configured.stdout,
                        stderr=configured.stderr,
                        started_ms=started_ms,
                    )
                verification_environment = dict(config_environment)
                verification_environment["GIT_CONFIG_GLOBAL"] = str(git_config)
                cache_directory = Path(temporary) / "cache"
                cache_directory.mkdir(mode=0o700)
                verification_environment["BABEL_CACHE_PATH"] = str(
                    cache_directory / "babel-register.json"
                )
                cloned = subprocess.run(
                    [
                        "git",
                        "clone",
                        "--shared",
                        "--no-checkout",
                        "--",
                        str(self.repository_root / ".git"),
                        str(worktree),
                    ],
                    cwd=temporary,
                    env=verification_environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=TOOL_TIMEOUT_MILLISECONDS / 1000,
                    check=False,
                    shell=False,
                )
                if cloned.returncode != 0:
                    return _verification_observation(
                        "environment_failure",
                        "verification_worktree_unavailable",
                        "The isolated verification workspace could not be prepared.",
                        stderr=cloned.stderr,
                        started_ms=started_ms,
                    )
                checked_out = subprocess.run(
                    [
                        "git",
                        "-c",
                        f"safe.directory={worktree.as_posix()}",
                        "checkout",
                        "--detach",
                        "HEAD",
                    ],
                    cwd=worktree,
                    env=verification_environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=TOOL_TIMEOUT_MILLISECONDS / 1000,
                    check=False,
                    shell=False,
                )
                if checked_out.returncode != 0:
                    return _verification_observation(
                        "environment_failure",
                        "verification_worktree_unavailable",
                        "The isolated verification workspace could not be prepared.",
                        stdout=checked_out.stdout,
                        stderr=checked_out.stderr,
                        started_ms=started_ms,
                    )
                source_modules = self.repository_root / "node_modules"
                if source_modules.is_dir() and not source_modules.is_symlink():
                    try:
                        os.symlink(source_modules, worktree / "node_modules", target_is_directory=True)
                    except OSError:
                        pass
                if patch:
                    apply_patch = subprocess.run(
                        [
                            "git",
                            "-c",
                            f"safe.directory={worktree.as_posix()}",
                            "apply",
                            "--binary",
                            "--whitespace=nowarn",
                            "-",
                        ],
                        cwd=worktree,
                        env=verification_environment,
                        input=patch,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=TOOL_TIMEOUT_MILLISECONDS / 1000,
                        check=False,
                        shell=False,
                    )
                    if apply_patch.returncode != 0:
                        return _verification_observation(
                            "environment_failure",
                            "verification_snapshot_apply_failed",
                            "The current patch could not be applied to the isolated verification workspace.",
                            stdout=apply_patch.stdout,
                            stderr=apply_patch.stderr,
                            started_ms=started_ms,
                        )
                if entry.preparation_argv is not None:
                    try:
                        preparation = subprocess.run(
                            list(entry.preparation_argv),
                            cwd=worktree,
                            env=verification_environment,
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            timeout=TOOL_TIMEOUT_MAX_MILLISECONDS / 1000,
                            check=False,
                            shell=False,
                        )
                    except subprocess.TimeoutExpired as error:
                        stdout = error.stdout if isinstance(error.stdout, bytes) else b""
                        stderr = error.stderr if isinstance(error.stderr, bytes) else b""
                        return _verification_observation(
                            "timed_out",
                            "verification_preparation_timeout",
                            "The Controller-owned build preparation exceeded the fixed verification timeout.",
                            stdout=stdout,
                            stderr=stderr,
                            timed_out=True,
                            started_ms=started_ms,
                        )
                    except OSError:
                        return _verification_observation(
                            "environment_failure",
                            "verification_preparation_unavailable",
                            "The Controller-owned build preparation could not start in the isolated workspace.",
                            started_ms=started_ms,
                        )
                    if preparation.returncode != 0:
                        return _verification_observation_from_command(
                            preparation,
                            "verification_preparation_failed",
                            "The Controller-owned build preparation failed before the selected test command could run.",
                            started_ms,
                        )
                try:
                    command = subprocess.run(
                        list(entry.argv),
                        cwd=worktree,
                        env=verification_environment,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=TOOL_TIMEOUT_MAX_MILLISECONDS / 1000,
                        check=False,
                        shell=False,
                    )
                except subprocess.TimeoutExpired as error:
                    stdout = error.stdout if isinstance(error.stdout, bytes) else b""
                    stderr = error.stderr if isinstance(error.stderr, bytes) else b""
                    return _verification_observation(
                        "timed_out",
                        "verification_timeout",
                        "The selected test command exceeded the fixed verification timeout.",
                        stdout=stdout,
                        stderr=stderr,
                        timed_out=True,
                        started_ms=started_ms,
                    )
                except OSError:
                    return _verification_observation(
                        "environment_failure",
                        "catalog_entry_stale",
                        "The preflighted command is no longer executable in the verification workspace.",
                        started_ms=started_ms,
                    )
                return _verification_observation_from_command(command, None, None, started_ms)
            except (OSError, subprocess.TimeoutExpired):
                return _verification_observation(
                    "environment_failure",
                    "verification_workspace_error",
                    "The isolated verification workspace failed before the test command could run.",
                    started_ms=started_ms,
                )
            finally:
                shutil.rmtree(worktree, ignore_errors=True)

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

    def _repo_read(
        self, arguments: Mapping[str, object]
    ) -> tuple[bytes, RuntimeReadMetadata, bool]:
        _require_allowed_keys(
            arguments,
            frozenset({"path", "start_line", "line_count"}),
            frozenset({"path"}),
        )
        target = self._resolve_path(_required_string(arguments, "path"))
        if not target.is_file():
            raise RuntimeToolError("repo_read path is not a regular file")
        try:
            content = _read_text_exact(target)
        except (OSError, UnicodeError) as error:
            raise RuntimeToolError("repo_read requires a readable UTF-8 file") from error
        start_line = _optional_integer(arguments, "start_line", 1, minimum=1, maximum=1_000_000)
        line_count = _optional_integer(arguments, "line_count", 500, minimum=1, maximum=2_000)
        lines = _text_lines(content)
        selected = lines[start_line - 1 : start_line - 1 + line_count]
        returned: list[str] = []
        returned_bytes = 0
        for line in selected:
            encoded = line.encode("utf-8")
            if returned_bytes + len(encoded) > TOOL_OUTPUT_LIMIT_BYTES:
                break
            returned.append(line)
            returned_bytes += len(encoded)
        body = "".join(returned)
        output_truncated = len(returned) < len(selected)
        returned_range = (
            None
            if not returned
            else RuntimeLineSpan(
                start_line=start_line,
                end_line_exclusive=start_line + len(returned),
            )
        )
        total_lines = len(lines)
        complete = not output_truncated and (
            total_lines == 0
            or (
                returned_range is not None
                and returned_range.start_line == 1
                and returned_range.end_line_exclusive == total_lines + 1
            )
        )
        relative_path = target.relative_to(self.repository_root).as_posix()
        metadata = RuntimeReadMetadata(
            path=relative_path,
            returned_range=returned_range,
            total_lines=total_lines,
            file_sha256=_text_sha256(content),
            source_sha256=_text_sha256(body),
            complete=complete,
        )
        return body.encode("utf-8"), metadata, output_truncated

    def _repo_search(self, arguments: Mapping[str, object]) -> bytes:
        _require_allowed_keys(
            arguments,
            frozenset({"query", "path", "cursor", "max_results"}),
            frozenset({"query"}),
        )
        query = _required_string(arguments, "query")
        if len(query.encode("utf-8")) > 1024:
            raise RuntimeToolError("repo_search query exceeds the fixed limit")
        relative = _optional_string(arguments, "path", ".")
        target = self._resolve_path(relative, allow_root=True)
        if not target.is_dir():
            raise RuntimeToolError("repo_search path is not a directory")
        cursor = _optional_integer(arguments, "cursor", 0, minimum=0, maximum=1_000_000)
        maximum_results = _optional_integer(arguments, "max_results", 100, minimum=1, maximum=500)
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
        page = rows[cursor : cursor + maximum_results]
        header = f"cursor: {cursor}\nresult_count: {len(page)}\n"
        if cursor + len(page) < len(rows):
            header += f"next_cursor: {cursor + len(page)}\n"
        return (header + "\n".join(page) + ("\n" if page else "")).encode("utf-8")

    def _repo_edit(
        self, arguments: Mapping[str, object]
    ) -> tuple[bytes, RuntimeEditMetadata]:
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
            relative_path = target.relative_to(self.repository_root).as_posix()
            total_lines = runtime_text_line_count(content)
            metadata = RuntimeCreateMetadata(
                path=relative_path,
                edit_kind="create",
                before_range=None,
                before_total_lines=None,
                before_file_sha256=None,
                after_range=RuntimeLineSpan(
                    start_line=1,
                    end_line_exclusive=total_lines + 1,
                ),
                after_total_lines=total_lines,
                after_file_sha256=_text_sha256(content),
                line_delta=None,
            )
            return f"created\t{relative_path}\n".encode("utf-8"), metadata

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
            original = _read_text_exact(target)
        except (OSError, UnicodeError) as error:
            raise RuntimeToolError("repo_edit replacement file could not be read as UTF-8") from error
        if original.count(old_text) != 1:
            raise RuntimeToolError("repo_edit old_text must occur exactly once in the existing file")
        start_offset = original.index(old_text)
        updated = original.replace(old_text, new_text, 1)
        before_total_lines = runtime_text_line_count(original)
        after_total_lines = runtime_text_line_count(updated)
        relative_path = target.relative_to(self.repository_root).as_posix()
        self._write_text_atomically(
            target,
            updated,
            mode=target.stat().st_mode & 0o777,
        )
        metadata = RuntimeReplaceMetadata(
            path=relative_path,
            edit_kind="replace",
            before_range=_text_line_span(original, start_offset, old_text),
            before_total_lines=before_total_lines,
            before_file_sha256=_text_sha256(original),
            after_range=_text_line_span(updated, start_offset, new_text),
            after_total_lines=after_total_lines,
            after_file_sha256=_text_sha256(updated),
            line_delta=after_total_lines - before_total_lines,
        )
        return f"replaced\t{relative_path}\n".encode("utf-8"), metadata

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
        descriptor = os.open(
            temporary,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0),
            0o600,
        )
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
        if executable.casefold() in _SHELL_INTERPRETERS:
            raise RuntimeToolError("repo_exec shell interpreters are prohibited")
        timeout_value = arguments.get("timeout_ms", TOOL_TIMEOUT_MILLISECONDS)
        if (
            isinstance(timeout_value, bool)
            or not isinstance(timeout_value, int)
            or timeout_value < 1
            or timeout_value > TOOL_TIMEOUT_MAX_MILLISECONDS
        ):
            raise RuntimeToolError("repo_exec timeout is outside the fixed policy")
        try:
            environment = self._verification_environment()
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
        *,
        output_truncated: bool = False,
        read_metadata: RuntimeReadMetadata | None = None,
        edit_metadata: RuntimeEditMetadata | None = None,
    ) -> RuntimeToolResult:
        bounded_stdout, bounded_stderr, truncated = _bound_output(stdout, stderr)
        return RuntimeToolResult(
            tool=tool,
            exit_code=exit_code,
            stdout=bounded_stdout.decode("utf-8", errors="replace"),
            stderr=bounded_stderr.decode("utf-8", errors="replace"),
            truncated=truncated or output_truncated,
            timed_out=timed_out,
            duration_ms=max(monotonic_ns() // 1_000_000 - started_ms, 0),
            read_metadata=read_metadata,
            edit_metadata=edit_metadata,
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

    def _verification_environment(self) -> dict[str, str]:
        environment = self._git_environment()
        # Verification caches are always placed on tmpfs. Neither the agent
        # worktree nor its snapshot may acquire test-run side effects.
        environment["HOME"] = "/tmp"
        environment["XDG_CACHE_HOME"] = "/tmp/repofixlab-xdg-cache"
        environment["XDG_CONFIG_HOME"] = "/tmp/repofixlab-xdg-config"
        environment["XDG_DATA_HOME"] = "/tmp/repofixlab-xdg-data"
        environment["NPM_CONFIG_CACHE"] = "/tmp/repofixlab-npm-cache"
        environment["npm_config_update_notifier"] = "false"
        return environment


def _verification_preparation_argv(
    repository_root: Path,
    package: object,
    scripts: Mapping[object, object],
) -> tuple[str, ...] | None:
    """Return the fixed build prerequisite for a missing package entrypoint.

    The Controller derives this only from the immutable package metadata. The
    Agent still selects only a catalogued test script and never supplies an
    argv or an install/build instruction.
    """
    if not isinstance(package, dict) or not isinstance(scripts.get("build"), str):
        return None
    main = package.get("main")
    if not isinstance(main, str) or not main or "\\" in main:
        return None
    path = PurePosixPath(main)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        return None
    entrypoint = repository_root.joinpath(*path.parts)
    if entrypoint.is_symlink() or entrypoint.is_file():
        return None
    return ("npm", "run", "build")


def _verification_script_is_terminating(name: object, value: object) -> bool:
    """Accept only a bounded Controller-owned npm verification candidate.

    A successful test report is not verification evidence when the command
    intentionally leaves a watch server running. Likewise a broad top-level
    test script that starts a parallel build is not a useful candidate in the
    fixed-process worker: it can fail before reaching the selected tests.
    """
    if (
        not isinstance(name, str)
        or not isinstance(value, str)
        or not (0 < len(name) <= 128)
        or not (name == "test" or name.startswith("test:") or "unit" in name or "spec" in name)
    ):
        return False
    command = value.casefold()
    if "--no-single-run" in command or "--watch" in command or " watch " in f" {command} ":
        return False
    return not (name == "test" and "npm-run-all" in command and "build" in command)


def _verification_environment_failure(
    stdout: bytes,
    stderr: bytes,
) -> tuple[str, str] | None:
    output = (stdout + b"\n" + stderr).decode("utf-8", errors="replace").casefold()
    if (
        "failed to create new os thread" in output
        or "runtime: may need to increase max user processes" in output
        or "pthread_create" in output
        or "resource temporarily unavailable" in output
        or "spawn /usr/bin/node eagain" in output
    ):
        return (
            "verification_resource_exhausted",
            "The isolated verification worker exhausted its fixed process or thread resources.",
        )
    if "babel could not write cache" in output:
        return (
            "verification_cache_unwritable",
            "The selected test command could not write its verification cache.",
        )
    if "cannot find module" in output and "/dist/" in output:
        return (
            "verification_missing_build_artifact",
            "The selected test command requires a build artifact that is absent from the isolated workspace.",
        )
    return None


def _verification_observation_from_command(
    command: subprocess.CompletedProcess[bytes],
    failure_reason_code: str | None,
    failure_safe_hint: str | None,
    started_ms: int,
) -> RuntimeVerificationObservation:
    if command.returncode == 0:
        return _verification_observation(
            "passed",
            None,
            None,
            exit_code=command.returncode,
            stdout=command.stdout,
            stderr=command.stderr,
            started_ms=started_ms,
        )
    environment_failure = _verification_environment_failure(command.stdout, command.stderr)
    if environment_failure is not None:
        reason_code, safe_hint = environment_failure
        return _verification_observation(
            "environment_failure",
            reason_code,
            safe_hint,
            exit_code=command.returncode,
            stdout=command.stdout,
            stderr=command.stderr,
            started_ms=started_ms,
        )
    return _verification_observation(
        "test_failed",
        failure_reason_code,
        failure_safe_hint,
        exit_code=command.returncode,
        stdout=command.stdout,
        stderr=command.stderr,
        started_ms=started_ms,
    )


def _canonical_verification_bytes(value: object) -> bytes:
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


def _verification_catalog(
    entries: tuple[RuntimeVerificationCatalogEntry, ...],
    source: bytes,
) -> RuntimeVerificationCatalog:
    source_sha256 = hashlib.sha256(source).hexdigest()
    identity = {
        "source_sha256": source_sha256,
        "entries": [
            {
                "candidate_id": entry.candidate_id,
                "description": entry.description,
                "argv": list(entry.argv),
                "preparation_argv": (
                    None if entry.preparation_argv is None else list(entry.preparation_argv)
                ),
            }
            for entry in entries
        ],
    }
    return RuntimeVerificationCatalog(
        catalog_id="verification-catalog-"
        + hashlib.sha256(_canonical_verification_bytes(identity)).hexdigest()[:32],
        source_sha256=source_sha256,
        entries=entries,
    )


def _verification_result(
    catalog_id: str,
    candidate_id: str,
    status: VerificationStatus,
    reason_code: str | None,
    safe_hint: str | None,
    *,
    exit_code: int | None = None,
    stdout: bytes = b"",
    stderr: bytes = b"",
    timed_out: bool = False,
    started_ms: int | None = None,
) -> RuntimeVerificationResult:
    observation = _verification_observation(
        status,
        reason_code,
        safe_hint,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
        started_ms=started_ms,
    )
    return _verification_result_from_observations(
        catalog_id,
        candidate_id,
        observation,
        observation,
    )


def _verification_observation(
    status: VerificationStatus,
    reason_code: str | None,
    safe_hint: str | None,
    *,
    exit_code: int | None = None,
    stdout: bytes = b"",
    stderr: bytes = b"",
    timed_out: bool = False,
    started_ms: int | None = None,
) -> RuntimeVerificationObservation:
    bounded_stdout, bounded_stderr, truncated = _bound_output(stdout, stderr)
    return RuntimeVerificationObservation(
        status=status,
        reason_code=reason_code,
        safe_hint=safe_hint,
        exit_code=exit_code,
        stdout=bounded_stdout.decode("utf-8", errors="replace"),
        stderr=bounded_stderr.decode("utf-8", errors="replace"),
        truncated=truncated,
        timed_out=timed_out,
        duration_ms=(
            0
            if started_ms is None
            else max(monotonic_ns() // 1_000_000 - started_ms, 0)
        ),
    )


def _verification_result_from_observations(
    catalog_id: str,
    candidate_id: str,
    baseline: RuntimeVerificationObservation,
    candidate: RuntimeVerificationObservation,
) -> RuntimeVerificationResult:
    # A shared resolver failure in two freshly-cloned worktrees is a harness
    # failure, not evidence that the candidate patch preserved behavior.
    if (
        baseline.status == "test_failed"
        and candidate.status == "test_failed"
        and baseline.stdout == candidate.stdout
        and baseline.stderr == candidate.stderr
        and 'could not resolve "../../"' in (baseline.stdout + "\n" + baseline.stderr).casefold()
    ):
        baseline = replace(
            baseline,
            status="environment_failure",
            reason_code="verification_workspace_resolution_failed",
            safe_hint="The isolated verification workspace cannot resolve the repository package entrypoint.",
        )
        candidate = replace(
            candidate,
            status="environment_failure",
            reason_code="verification_workspace_resolution_failed",
            safe_hint="The isolated verification workspace cannot resolve the repository package entrypoint.",
        )
    return RuntimeVerificationResult(
        catalog_id=catalog_id,
        candidate_id=candidate_id,
        status=candidate.status,
        reason_code=candidate.reason_code,
        safe_hint=candidate.safe_hint,
        exit_code=candidate.exit_code,
        stdout=candidate.stdout,
        stderr=candidate.stderr,
        truncated=candidate.truncated,
        timed_out=candidate.timed_out,
        duration_ms=candidate.duration_ms,
        baseline=baseline,
    )


def tool_rejection_reason_code(error: RuntimeToolError) -> str:
    message = str(error)
    if "shell interpreters" in message:
        return "shell_prohibited"
    if "must use PATH lookup" in message:
        return "executable_path_prohibited"
    if "test paths are prohibited" in message:
        return "test_edit_prohibited"
    if "symbolic link" in message or "escapes the fixed worktree" in message:
        return "path_escape_prohibited"
    if "timeout" in message:
        return "timeout_policy_violation"
    if "process could not be started" in message:
        return "argv_not_found"
    if "path" in message:
        return "invalid_repository_path"
    if "arguments" in message or "argument" in message or "argv" in message:
        return "invalid_tool_input"
    return "tool_policy_rejected"


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


def _optional_integer(
    value: Mapping[str, object], name: str, default: int, *, minimum: int, maximum: int
) -> int:
    item = value.get(name, default)
    if isinstance(item, bool) or not isinstance(item, int) or item < minimum or item > maximum:
        raise RuntimeToolError(f"runtime tool argument {name} is malformed")
    return item
