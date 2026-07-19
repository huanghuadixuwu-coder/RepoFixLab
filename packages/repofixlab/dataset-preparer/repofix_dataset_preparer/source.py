from __future__ import annotations

import ipaddress
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .canonical import sha256_bytes
from .constants import (
    DATASET_NAME,
    DATASET_REVISION,
    DATASET_SOURCE_BYTES,
    DATASET_SOURCE_PATH,
    DATASET_SOURCE_SHA256,
    MAX_SOURCE_BYTES,
)
from .errors import PreparationError

_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_ALLOWED_REDIRECT_SUFFIXES = ("huggingface.co", "hf.co", "xethub.hf.co")


@dataclass(frozen=True)
class SourceAudit:
    source_kind: str
    source_sha256: str
    source_bytes: int
    requested_url: str | None
    final_url: str | None
    redirect_chain: tuple[str, ...]


@dataclass(frozen=True)
class LoadedSource:
    rows: tuple[dict[str, Any], ...]
    audit: SourceAudit


def _sanitized_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _is_allowed_huggingface_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.rstrip(".").lower()
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        address = None
    if address is not None:
        return False
    return any(
        normalized == suffix or normalized.endswith(f".{suffix}")
        for suffix in _ALLOWED_REDIRECT_SUFFIXES
    )


class _AuditedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self) -> None:
        self.redirects: list[str] = []

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise PreparationError("dataset redirect must remain credential-free HTTPS")
        if not _is_allowed_huggingface_host(parsed.hostname):
            raise PreparationError("dataset redirect left the audited Hugging Face host set")
        if len(self.redirects) >= 5:
            raise PreparationError("dataset redirect limit exceeded")
        self.redirects.append(_sanitized_url(newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _validate_expected_sha256(expected_sha256: str) -> None:
    if _SHA256.fullmatch(expected_sha256) is None:
        raise PreparationError("source SHA-256 must be 64 lowercase hexadecimal characters")
    if expected_sha256 != DATASET_SOURCE_SHA256:
        raise PreparationError("source SHA-256 does not match the frozen dataset object")


def _validate_pinned_source_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "huggingface.co"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise PreparationError("source URL must be a query-free HTTPS huggingface.co URL")
    expected_prefix = (
        f"/datasets/{DATASET_NAME}/resolve/{DATASET_REVISION}/"
    )
    decoded_path = urllib.parse.unquote(parsed.path)
    if not decoded_path.startswith(expected_prefix):
        raise PreparationError("source URL does not bind the frozen dataset name and revision")
    if decoded_path != f"{expected_prefix}{DATASET_SOURCE_PATH}":
        raise PreparationError("source URL does not identify the frozen Parquet object")


def validate_source_request(
    *,
    source_file: Path | None,
    source_url: str | None,
    expected_sha256: str,
) -> Path | None:
    _validate_expected_sha256(expected_sha256)
    if (source_file is None) == (source_url is None):
        raise PreparationError("exactly one dataset source must be selected")
    if source_url is not None:
        _validate_pinned_source_url(source_url)
        return None

    assert source_file is not None
    resolved_source = source_file.resolve(strict=True)
    input_root = Path("/input").resolve(strict=True)
    if resolved_source != input_root and input_root not in resolved_source.parents:
        raise PreparationError("local source file must be mounted below /input")
    return resolved_source


def _read_limited(response: Any) -> bytes:
    declared = response.headers.get("Content-Length")
    if declared is not None:
        try:
            declared_bytes = int(declared)
        except ValueError as error:
            raise PreparationError("dataset response has an invalid Content-Length") from error
        if declared_bytes < 0 or declared_bytes > MAX_SOURCE_BYTES:
            raise PreparationError("dataset response exceeds the source size limit")

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_SOURCE_BYTES:
            raise PreparationError("dataset response exceeds the source size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def load_url(url: str, expected_sha256: str) -> LoadedSource:
    _validate_expected_sha256(expected_sha256)
    _validate_pinned_source_url(url)
    redirect_handler = _AuditedRedirectHandler()
    opener = urllib.request.build_opener(redirect_handler)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "RepoFixLab-Dataset-Preparer/1"},
        method="GET",
    )
    try:
        with opener.open(request, timeout=60) as response:
            if response.status != 200:
                raise PreparationError(f"dataset download returned HTTP {response.status}")
            content = _read_limited(response)
            final_url = _sanitized_url(response.geturl())
    except PreparationError:
        raise
    except (OSError, urllib.error.URLError) as error:
        raise PreparationError(f"dataset download failed: {error}") from error

    actual_sha256 = sha256_bytes(content)
    if len(content) != DATASET_SOURCE_BYTES:
        raise PreparationError("downloaded dataset size does not match the frozen value")
    if actual_sha256 != expected_sha256:
        raise PreparationError("downloaded dataset SHA-256 does not match the frozen value")
    rows = _parse_content(content, urllib.parse.urlsplit(url).path)
    return LoadedSource(
        rows=rows,
        audit=SourceAudit(
            source_kind="https",
            source_sha256=actual_sha256,
            source_bytes=len(content),
            requested_url=_sanitized_url(url),
            final_url=final_url,
            redirect_chain=tuple(redirect_handler.redirects),
        ),
    )


def load_file(path: Path, expected_sha256: str) -> LoadedSource:
    _validate_expected_sha256(expected_sha256)
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise PreparationError("dataset source is not a regular file")
    size = resolved.stat().st_size
    if resolved.name != Path(DATASET_SOURCE_PATH).name:
        raise PreparationError("dataset file name does not match the frozen source object")
    if size != DATASET_SOURCE_BYTES:
        raise PreparationError("dataset file size does not match the frozen value")
    if size > MAX_SOURCE_BYTES:
        raise PreparationError("dataset source exceeds the source size limit")
    content = resolved.read_bytes()
    actual_sha256 = sha256_bytes(content)
    if actual_sha256 != expected_sha256:
        raise PreparationError("dataset file SHA-256 does not match the frozen value")
    rows = _parse_content(content, resolved.name)
    return LoadedSource(
        rows=rows,
        audit=SourceAudit(
            source_kind="file",
            source_sha256=actual_sha256,
            source_bytes=len(content),
            requested_url=None,
            final_url=None,
            redirect_chain=(),
        ),
    )


def _parse_content(content: bytes, name: str) -> tuple[dict[str, Any], ...]:
    if name.lower().endswith(".jsonl"):
        return _parse_jsonl(content)
    if name.lower().endswith(".parquet"):
        return _parse_parquet(content)
    raise PreparationError("dataset source extension must be .jsonl or .parquet")


def _parse_jsonl(content: bytes) -> tuple[dict[str, Any], ...]:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PreparationError("dataset JSONL is not UTF-8") from error
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            raise PreparationError(f"dataset JSONL contains a blank line at {line_number}")
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise PreparationError(f"invalid dataset JSON at line {line_number}") from error
        if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
            raise PreparationError(f"dataset row {line_number} must be a string-keyed object")
        rows.append(value)
    if not rows:
        raise PreparationError("dataset source contains no rows")
    return tuple(rows)


def _parse_parquet(content: bytes) -> tuple[dict[str, Any], ...]:
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as error:
        raise PreparationError("Parquet input requires the locked pyarrow dependency") from error
    try:
        table = pq.read_table(pa.BufferReader(content))
        values = table.to_pylist()
    except Exception as error:
        raise PreparationError("failed to parse the frozen Parquet source") from error
    rows: list[dict[str, Any]] = []
    for index, value in enumerate(values):
        if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
            raise PreparationError(f"Parquet row {index} must be a string-keyed object")
        rows.append(value)
    if not rows:
        raise PreparationError("dataset source contains no rows")
    return tuple(rows)
