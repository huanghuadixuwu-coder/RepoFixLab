"""Optional monotonic runtime spans, scoped to one trusted recorder.

Nested spans retain their parent and absolute monotonic timestamps. Consumers
measure unions or enclosing wall time so overlapping work is never added twice.
The default context emits nothing and preserves return values and exceptions.
"""

from _thread import LockType
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from threading import Lock
from time import monotonic_ns
from typing import ParamSpec, TypeVar


P = ParamSpec("P")
T = TypeVar("T")
_scope: ContextVar[tuple["RuntimeTimings", dict[str, object]] | None] = ContextVar("runtime_timing_scope", default=None)


class RuntimeTimings:
    """Collect spans safely across explicit per-thread recording contexts."""

    def __init__(self, clock: Callable[[], int] = monotonic_ns) -> None:
        self.clock = clock
        self.records: list[dict[str, object]] = []
        self._lock = Lock()
        self._next_id = 0

    @contextmanager
    def recording(self, **identity: object) -> Iterator[None]:
        token = _scope.set((self, identity))
        try:
            yield
        finally:
            _scope.reset(token)

    def append(self, record: dict[str, object]) -> None:
        with self._lock:
            self.records.append(record)

    def next_id(self) -> int:
        with self._lock:
            self._next_id += 1
            return self._next_id


@contextmanager
def runtime_phase(phase: str, *, role: str | None = None, detached: bool = False) -> Iterator[None]:
    """Observe one phase without taking ownership of its operation or result."""
    active = _scope.get()
    if active is None:
        yield
        return
    recorder, identity = active
    if detached:
        # Background work retains task identity and may outlive its caller.
        identity = {key: value for key, value in identity.items() if key != "parent_id"}
    span_id = recorder.next_id()
    started = recorder.clock()
    child_identity = {**identity, "parent_id": span_id}
    if role is not None:
        child_identity["role"] = role
    token = _scope.set((recorder, child_identity))
    error_class = None
    try:
        yield
    except BaseException as error:
        error_class = type(error).__name__
        raise
    finally:
        ended = recorder.clock()
        _scope.reset(token)
        recorder.append({
            **identity,
            "record_type": "span",
            "span_id": span_id,
            "phase": phase,
            "role": child_identity.get("role", "controller"),
            "started_ns": started,
            "ended_ns": ended,
            "duration_ns": ended - started,
            "outcome": "failed" if error_class else "completed",
            "error_class": error_class,
        })


def timed(phase: str, *, role: str | None = None) -> Callable[[Callable[P, T]], Callable[P, T]]:
    """Decorate synchronous runtime boundaries; SDK and policy semantics stay intact."""
    def decorate(function: Callable[P, T]) -> Callable[P, T]:
        @wraps(function)
        def observed(*args: P.args, **kwargs: P.kwargs) -> T:
            with runtime_phase(phase, role=role):
                return function(*args, **kwargs)
        return observed
    return decorate


@contextmanager
def timed_lock(lock: LockType) -> Iterator[None]:
    """Measure only lock acquisition, while retaining the original critical section."""
    with runtime_phase("queue.wait"):
        lock.acquire()
    try:
        yield
    finally:
        lock.release()


def interval_union_ns(records: list[dict[str, object]]) -> int:
    """Return occupied time, including nested and overlapping intervals once."""
    intervals = sorted((int(item["started_ns"]), int(item["ended_ns"])) for item in records)
    total = 0
    end = 0
    for start, stop in intervals:
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total
