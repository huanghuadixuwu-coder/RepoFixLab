from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RECORD_LIMIT_BYTES = 4 * 1024 * 1024
_RECORD_KEYS = frozenset(
    {
        "schema_version",
        "record_type",
        "event",
        "sequence",
        "attempt_id",
        "operation_id",
        "request_sha256",
        "request",
        "response",
        "at",
        "previous_record_sha256",
        "record_sha256",
    }
)


class RuntimeJournalError(RuntimeError):
    """The append-only runtime journal cannot be trusted or recovered."""


def canonical_runtime_bytes(value: object) -> bytes:
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


def runtime_request_sha256(request: Mapping[str, object]) -> str:
    if "request_sha256" in request:
        raise RuntimeJournalError(
            "canonical runtime request input must not contain request_sha256"
        )
    return hashlib.sha256(canonical_runtime_bytes(request)).hexdigest()


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(canonical_runtime_bytes(value)).hexdigest()


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _unique_json_object(pairs: Sequence[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for name, item in pairs:
        if name in value:
            raise RuntimeJournalError(f"duplicate JSON member is forbidden: {name}")
        value[name] = item
    return value


def _reject_json_constant(value: str) -> object:
    raise RuntimeJournalError(f"non-finite JSON value is forbidden: {value}")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_all(descriptor: int, value: bytes) -> None:
    offset = 0
    while offset < len(value):
        written = os.write(descriptor, value[offset:])
        if written < 1:
            raise OSError("short append-only runtime journal write")
        offset += written


@dataclass(frozen=True)
class RuntimeJournalRecord:
    event: str
    sequence: int
    attempt_id: str
    operation_id: str
    request_sha256: str
    request: Mapping[str, object]
    response: Mapping[str, object] | None
    at: str
    previous_record_sha256: str | None
    record_sha256: str

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": "v1",
            "record_type": "runtime_operation_event",
            "event": self.event,
            "sequence": self.sequence,
            "attempt_id": self.attempt_id,
            "operation_id": self.operation_id,
            "request_sha256": self.request_sha256,
            "request": dict(self.request),
            "response": dict(self.response) if self.response is not None else None,
            "at": self.at,
            "previous_record_sha256": self.previous_record_sha256,
            "record_sha256": self.record_sha256,
        }


@dataclass(frozen=True)
class PersistedRuntimeOperation:
    request: Mapping[str, object]
    request_sha256: str
    accepted_at: str
    last_record: RuntimeJournalRecord
    response: Mapping[str, object] | None


class RuntimeOperationJournal:
    def __init__(self, root: Path) -> None:
        if not root.is_absolute():
            raise RuntimeJournalError("runtime journal root must be absolute")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.is_symlink() or not root.is_dir():
            raise RuntimeJournalError("runtime journal root is not a real directory")
        self.root = root
        self._journal_path = root / "journal.jsonl"
        self._lease = os.open(root / ".owner.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self._lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(self._lease)
            raise RuntimeJournalError("another runtime journal owner is active") from error
        self._records_by_operation: dict[str, RuntimeJournalRecord] = {}
        self._last_record: RuntimeJournalRecord | None = None

    def close(self) -> None:
        if self._lease < 0:
            return
        try:
            fcntl.flock(self._lease, fcntl.LOCK_UN)
        finally:
            os.close(self._lease)
            self._lease = -1

    def begin(
        self,
        request: Mapping[str, object],
        request_sha256: str,
        *,
        accepted_at: str | None = None,
    ) -> RuntimeJournalRecord:
        attempt_id, operation_id = _validate_request_binding(request, request_sha256)
        if operation_id in self._records_by_operation:
            raise RuntimeJournalError("runtime operation journal already exists")
        return self._append(
            request,
            request_sha256,
            attempt_id=attempt_id,
            operation_id=operation_id,
            event="accepted",
            response=None,
            at=accepted_at or _now(),
        )

    def finish(
        self,
        request: Mapping[str, object],
        request_sha256: str,
        response: Mapping[str, object],
        *,
        event: str = "completed",
        finished_at: str | None = None,
    ) -> RuntimeJournalRecord:
        if event not in {"completed", "recovered_interrupted"}:
            raise RuntimeJournalError("runtime terminal event is unsupported")
        attempt_id, operation_id = _validate_request_binding(request, request_sha256)
        previous = self._records_by_operation.get(operation_id)
        if previous is None or previous.event != "accepted":
            raise RuntimeJournalError("runtime operation is not pending")
        if (
            previous.attempt_id != attempt_id
            or previous.request_sha256 != request_sha256
            or dict(previous.request) != dict(request)
        ):
            raise RuntimeJournalError("runtime terminal request binding drifted")
        _validate_response_binding(response, attempt_id, operation_id, request_sha256)
        return self._append(
            request,
            request_sha256,
            attempt_id=attempt_id,
            operation_id=operation_id,
            event=event,
            response=response,
            at=finished_at or _now(),
        )

    def _append(
        self,
        request: Mapping[str, object],
        request_sha256: str,
        *,
        attempt_id: str,
        operation_id: str,
        event: str,
        response: Mapping[str, object] | None,
        at: str,
    ) -> RuntimeJournalRecord:
        sequence = 0 if self._last_record is None else self._last_record.sequence + 1
        previous_hash = (
            self._last_record.record_sha256 if self._last_record is not None else None
        )
        unsigned: dict[str, object] = {
            "schema_version": "v1",
            "record_type": "runtime_operation_event",
            "event": event,
            "sequence": sequence,
            "attempt_id": attempt_id,
            "operation_id": operation_id,
            "request_sha256": request_sha256,
            "request": dict(request),
            "response": dict(response) if response is not None else None,
            "at": at,
            "previous_record_sha256": previous_hash,
        }
        record = RuntimeJournalRecord(
            event=event,
            sequence=sequence,
            attempt_id=attempt_id,
            operation_id=operation_id,
            request_sha256=request_sha256,
            request=dict(request),
            response=dict(response) if response is not None else None,
            at=at,
            previous_record_sha256=previous_hash,
            record_sha256=_canonical_sha256(unsigned),
        )
        descriptor = os.open(
            self._journal_path,
            os.O_APPEND | os.O_CREAT | os.O_WRONLY,
            0o600,
        )
        try:
            _write_all(descriptor, canonical_runtime_bytes(record.to_dict()))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _fsync_directory(self.root)
        self._records_by_operation[operation_id] = record
        self._last_record = record
        return record

    def load(self) -> tuple[PersistedRuntimeOperation, ...]:
        if not self._journal_path.exists():
            return ()
        if self._journal_path.is_symlink() or not self._journal_path.is_file():
            raise RuntimeJournalError("runtime journal is not a regular file")
        try:
            lines = self._journal_path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as error:
            raise RuntimeJournalError("runtime journal is unreadable") from error
        if not lines:
            raise RuntimeJournalError("runtime journal is empty")
        records = tuple(self._parse_record(line) for line in lines)
        grouped: dict[str, list[RuntimeJournalRecord]] = {}
        for index, record in enumerate(records):
            if record.sequence != index:
                raise RuntimeJournalError("runtime journal sequence is not contiguous")
            if index == 0:
                if record.previous_record_sha256 is not None:
                    raise RuntimeJournalError(
                        "first runtime journal record has a predecessor"
                    )
            elif record.previous_record_sha256 != records[index - 1].record_sha256:
                raise RuntimeJournalError("runtime journal hash chain is broken")
            grouped.setdefault(record.operation_id, []).append(record)
            self._last_record = record

        operations: list[PersistedRuntimeOperation] = []
        for operation_id, operation_records in grouped.items():
            accepted = operation_records[0]
            if accepted.event != "accepted" or len(operation_records) > 2:
                raise RuntimeJournalError("runtime operation event order is invalid")
            if len(operation_records) == 2 and operation_records[1].event not in {
                "completed",
                "recovered_interrupted",
            }:
                raise RuntimeJournalError("runtime terminal event is invalid")
            for record in operation_records[1:]:
                if (
                    record.attempt_id != accepted.attempt_id
                    or record.request_sha256 != accepted.request_sha256
                    or dict(record.request) != dict(accepted.request)
                ):
                    raise RuntimeJournalError("runtime operation request binding drifted")
            terminal = operation_records[-1]
            self._records_by_operation[operation_id] = terminal
            operations.append(
                PersistedRuntimeOperation(
                    request=dict(accepted.request),
                    request_sha256=accepted.request_sha256,
                    accepted_at=accepted.at,
                    last_record=terminal,
                    response=(
                        dict(terminal.response)
                        if terminal.response is not None
                        else None
                    ),
                )
            )
        operations.sort(key=lambda operation: operation.last_record.sequence)
        return tuple(operations)

    @staticmethod
    def _parse_record(line: str) -> RuntimeJournalRecord:
        if not line or len(line.encode("utf-8")) > _RECORD_LIMIT_BYTES:
            raise RuntimeJournalError("runtime journal record size is invalid")
        try:
            value = json.loads(
                line,
                object_pairs_hook=_unique_json_object,
                parse_constant=_reject_json_constant,
            )
        except (json.JSONDecodeError, RuntimeJournalError) as error:
            raise RuntimeJournalError(
                "runtime journal record is not strict JSON"
            ) from error
        if not isinstance(value, dict) or set(value) != _RECORD_KEYS:
            raise RuntimeJournalError("runtime journal record envelope is not exact")
        unsigned = dict(value)
        actual_hash = unsigned.pop("record_sha256")
        if actual_hash != _canonical_sha256(unsigned):
            raise RuntimeJournalError("runtime journal record hash is invalid")
        event = value.get("event")
        sequence = value.get("sequence")
        attempt_id = value.get("attempt_id")
        operation_id = value.get("operation_id")
        request_hash = value.get("request_sha256")
        request = value.get("request")
        response = value.get("response")
        at = value.get("at")
        previous = value.get("previous_record_sha256")
        if (
            value.get("schema_version") != "v1"
            or value.get("record_type") != "runtime_operation_event"
            or event not in {"accepted", "completed", "recovered_interrupted"}
            or isinstance(sequence, bool)
            or not isinstance(sequence, int)
            or sequence < 0
            or not isinstance(attempt_id, str)
            or _IDENTIFIER.fullmatch(attempt_id) is None
            or not isinstance(operation_id, str)
            or _IDENTIFIER.fullmatch(operation_id) is None
            or not isinstance(request_hash, str)
            or _SHA256.fullmatch(request_hash) is None
            or not isinstance(request, dict)
            or (response is not None and not isinstance(response, dict))
            or not isinstance(at, str)
            or not at
            or (
                previous is not None
                and (not isinstance(previous, str) or _SHA256.fullmatch(previous) is None)
            )
            or not isinstance(actual_hash, str)
        ):
            raise RuntimeJournalError("runtime journal record fields are malformed")
        if (event == "accepted") != (response is None):
            raise RuntimeJournalError("runtime journal response state is inconsistent")
        _validate_request_binding(request, request_hash)
        if response is not None:
            _validate_response_binding(
                response,
                attempt_id,
                operation_id,
                request_hash,
            )
        return RuntimeJournalRecord(
            event=event,
            sequence=sequence,
            attempt_id=attempt_id,
            operation_id=operation_id,
            request_sha256=request_hash,
            request=request,
            response=response,
            at=at,
            previous_record_sha256=previous,
            record_sha256=actual_hash,
        )


def _validate_request_binding(
    request: Mapping[str, object], request_sha256: str
) -> tuple[str, str]:
    attempt_id = request.get("attempt_id")
    operation_id = request.get("operation_id")
    request_type = request.get("request_type")
    if (
        request.get("schema_version") != "v1"
        or not isinstance(request_type, str)
        or not request_type.startswith("runtime_")
        or not isinstance(attempt_id, str)
        or _IDENTIFIER.fullmatch(attempt_id) is None
        or not isinstance(operation_id, str)
        or _IDENTIFIER.fullmatch(operation_id) is None
        or _SHA256.fullmatch(request_sha256) is None
        or runtime_request_sha256(request) != request_sha256
    ):
        raise RuntimeJournalError("runtime request binding is invalid")
    return attempt_id, operation_id


def _validate_response_binding(
    response: Mapping[str, object],
    attempt_id: str,
    operation_id: str,
    request_sha256: str,
) -> None:
    response_type = response.get("response_type")
    if (
        response.get("schema_version") != "v1"
        or not isinstance(response_type, str)
        or not response_type.startswith("runtime_")
        or response.get("attempt_id") != attempt_id
        or response.get("operation_id") != operation_id
        or response.get("request_sha256") != request_sha256
    ):
        raise RuntimeJournalError("runtime response binding is invalid")
