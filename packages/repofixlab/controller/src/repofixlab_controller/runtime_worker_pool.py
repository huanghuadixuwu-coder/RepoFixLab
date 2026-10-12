"""Bound speculative role preparation, single claims and audited retirement.

Docker policy and physical ownership stay in the backend. This pool coordinates
one preparation per environment and keeps dirty resources charged until cleanup.
"""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import copy_context
from dataclasses import dataclass, field
from math import isfinite
from threading import Condition, Event, Thread
from time import monotonic, monotonic_ns
from typing import Generic, Literal, TypeVar
from uuid import uuid4

from .runtime_admission import RuntimeAdmissionBusy, RuntimeAdmissionCancelled, RuntimeAdmissionTimeout
from .runtime_timing import runtime_phase


T = TypeVar("T")


@dataclass
class _Entry(Generic[T]):
    owner_id: str
    key: str
    interests: set[str] = field(default_factory=set)
    state: str = "preparing"
    worker: T | None = None
    ready_at: float = 0
    retire_reason: str | None = None
    waiting_attempt: str | None = None


class WorkerPool(Generic[T]):
    """Bound preparation and verified returns by immutable physical ownership."""

    def __init__(self, capacity: int, idle_seconds: float, *,
                 reserve: Callable[[str, str], bool], prepare: Callable[[str, str], T],
                 bind: Callable[[T, str, str], T], cleanup: Callable[[str], bool],
                 interrupt: Callable[[str], None] | None = None,
                 role: Literal["worker", "evaluator"] = "worker") -> None:
        if capacity not in {1, 2} or not isfinite(idle_seconds) or idle_seconds <= 0:
            raise ValueError("invalid Worker pool limits")
        self._capacity = capacity
        self._role = role
        self._idle_seconds = idle_seconds
        self._reserve = reserve
        self._prepare_worker = prepare
        self._bind = bind
        self._cleanup = cleanup
        self._interrupt = interrupt
        self._condition = Condition()
        self._entries: dict[str, _Entry[T]] = {}
        self._offered: dict[str, str] = {}
        self._cancelled: set[str] = set()
        self._demand_waiters = 0
        self.records: list[dict[str, object]] = []
        self._executor = ThreadPoolExecutor(max_workers=capacity, thread_name_prefix=f"{role}-warm")
        self._stop = Event()
        self._sweeper = Thread(target=self._expire, name=f"{role}-pool-expiry", daemon=True)
        self._sweeper.start()

    @property
    def snapshot(self) -> dict[str, int]:
        with self._condition:
            return {state: sum(entry.state == state for entry in self._entries.values())
                    for state in ("preparing", "resetting", "validated", "ready", "claiming", "retiring", "blocked")}

    def _record(self, event: str, entry: _Entry[T] | None = None, **fields: object) -> None:
        self.records.append({"record_type": f"{self._role}_pool", "event": event, "at_ns": monotonic_ns(),
                             **({"owner_id": entry.owner_id, "environment_sha256": entry.key} if entry else {}),
                             **fields})

    def offer(self, attempt_id: str, key: str) -> None:
        """Merge demand; replace an idle duplicate to warm a new environment."""
        with self._condition:
            if attempt_id in self._offered:
                if self._offered[attempt_id] != key:
                    raise ValueError("Worker pool attempt environment drifted")
                return
            self._offered[attempt_id] = key
        while True:
            with self._condition:
                if self._stop.is_set() or attempt_id in self._cancelled or self._demand_waiters:
                    self._record("skipped", attempt_id=attempt_id, reason="demand_priority")
                    return
                for entry in self._entries.values():
                    if entry.key == key and entry.state in {"preparing", "resetting", "validated", "ready"} and entry.retire_reason is None:
                        # A returned physical container can satisfy one queued
                        # claim. Preserve preparation merging for fresh offers.
                        if (self._role == "worker" and entry.state == "ready"
                                and getattr(entry.worker, "parked", False) and entry.interests):
                            continue
                        if len(entry.interests) < (2 if self._role == "evaluator" else self._capacity):
                            entry.interests.add(attempt_id)
                        self._record("merged", entry, attempt_id=attempt_id)
                        return
                if any(item.state == "blocked" for item in self._entries.values()):
                    self._record("skipped", attempt_id=attempt_id, reason="pool_capacity")
                    return
                if len(self._entries) >= self._capacity:
                    additional_demand = any(item.key == key and item.state == "ready" and item.interests
                        and getattr(item.worker, "parked", False) for item in self._entries.values())
                    duplicate = next((item for item in self._entries.values()
                        if item.state == "ready" and not item.interests and item.retire_reason is None
                        and ((additional_demand and item.key != key)
                             or sum(other.key == item.key and other.state == "ready"
                                    for other in self._entries.values()) > 1)), None)
                    if duplicate is None:
                        self._record("skipped", attempt_id=attempt_id, reason="pool_capacity")
                        return
                    duplicate.state = "retiring"
                    duplicate.retire_reason = "environment_demand"
                else:
                    entry = _Entry[T](f"warm-{self._role}-{uuid4().hex}", key, {attempt_id})
                    if not self._reserve(entry.owner_id, key):
                        self._record("skipped", attempt_id=attempt_id, reason="resource_budget")
                        return
                    self._entries[entry.owner_id] = entry
                    self._record("prepare_started", entry)
                    context = copy_context()
                    self._executor.submit(context.run, self._prepare, entry)
                    return
            # Keep the victim charged until physical cleanup; recheck demand,
            # cancellation and capacity after releasing the pool lock.
            self._retire(duplicate)

    def _prepare(self, entry: _Entry[T]) -> None:
        started = monotonic_ns()
        try:
            with runtime_phase(f"{self._role}.prewarm", role=self._role, detached=True):
                worker = self._prepare_worker(entry.owner_id, entry.key)
            with self._condition:
                entry.worker = worker
                entry.ready_at = monotonic()
                self._record("prepared", entry, duration_ns=monotonic_ns() - started,
                             container_id=getattr(getattr(worker, "container", None), "id", None))
                if entry.retire_reason is None:
                    entry.state = "ready"
                    self._condition.notify_all()
                    return
                entry.state = "retiring"
        except Exception as error:
            with self._condition:
                entry.state = "retiring"
                entry.retire_reason = "prepare_failed"
                self._record("prepare_failed", entry, error_class=type(error).__name__, error_message=str(error),
                             duration_ns=monotonic_ns() - started)
        self._retire(entry)

    def wait_prepared(self, timeout_seconds: float = 60) -> None:
        """Allow an explicit known-queue warmup to finish within its own deadline."""
        deadline = monotonic() + timeout_seconds
        with self._condition:
            while any(item.state in {"preparing", "resetting"} for item in self._entries.values()):
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise RuntimeAdmissionTimeout("worker_prewarm_timeout")
                self._condition.wait(remaining)
            if any(item.state == "blocked" for item in self._entries.values()):
                raise RuntimeError("Worker pool cleanup is blocked")

    def take(self, attempt_id: str, key: str, *, timeout_seconds: float = 300) -> T | None:
        """Reserve one waiter; bind outside the lock while retaining ownership."""
        deadline = monotonic() + timeout_seconds
        with runtime_phase(f"{self._role}.pool_wait", role=self._role):
            with self._condition:
                entry = None
                try:
                    while True:
                        if attempt_id in self._cancelled:
                            raise RuntimeAdmissionCancelled("runtime_queue_cancelled")
                        if self._stop.is_set() or any(item.state == "blocked" for item in self._entries.values()):
                            raise RuntimeError("Worker pool is closed or cleanup is blocked")
                        entry = next((item for item in self._entries.values()
                            if item.key == key and item.retire_reason is None and item.state != "claiming"
                            and item.waiting_attempt in {None, attempt_id}), None)
                        if entry is None:
                            self._record("miss", attempt_id=attempt_id, environment_sha256=key)
                            return None
                        entry.waiting_attempt = attempt_id
                        if entry.state == "ready" and entry.worker is not None:
                            entry.state = "claiming"
                            break
                        remaining = deadline - monotonic()
                        if remaining <= 0:
                            raise RuntimeAdmissionTimeout("runtime_queue_timeout")
                        self._condition.wait(remaining)
                finally:
                    if entry is not None and entry.waiting_attempt == attempt_id:
                        entry.waiting_attempt = None
                        self._condition.notify_all()
            try:
                worker = self._bind(entry.worker, attempt_id, key)
                with self._condition:
                    if attempt_id in self._cancelled:
                        raise RuntimeAdmissionCancelled("runtime_queue_cancelled")
                    if self._stop.is_set() or entry.retire_reason is not None:
                        raise RuntimeError("Worker pool claim was retired")
                    del self._entries[entry.owner_id]
                    self._record("hit", entry, attempt_id=attempt_id,
                                 container_id=getattr(getattr(worker, "container", None), "id", None),
                                 generation=getattr(worker, "generation", 0))
                    self._condition.notify_all()
                    return worker
            except Exception as error:
                claim_error = error
                with self._condition:
                    entry.state = "retiring"
                    entry.retire_reason = "claim_rejected"
        self._retire(entry)
        if isinstance(claim_error, (RuntimeAdmissionCancelled, RuntimeAdmissionBusy)):
            raise claim_error
        raise RuntimeError("Worker pool claim readiness or identity failed") from claim_error

    def recycle(self, worker: T, key: str, reset: Callable[[T], T]) -> bool:
        """Reset a returned lease once; publish only after its journal receipt."""
        owner = getattr(worker, "resource_owner", None) or getattr(worker, "attempt_id")
        with self._condition:
            if (self._stop.is_set() or len(self._entries) >= self._capacity
                    or any(item.state == "blocked" for item in self._entries.values())):
                self._record("return_skipped", attempt_id=getattr(worker, "attempt_id"), reason="pool_capacity")
                return False
            entry = _Entry[T](owner, key, {getattr(worker, "attempt_id")}, state="resetting", worker=worker)
            self._entries[owner] = entry
            self._record("reset_started", entry, attempt_id=getattr(worker, "attempt_id"),
                         generation=getattr(worker, "generation", 0), container_id=getattr(worker, "container").id)
        started = monotonic_ns()
        try:
            returned = reset(worker)
        except Exception as error:
            with self._condition:
                entry.state = "retiring"
                entry.retire_reason = "reset_failed"
                self._record("reset_failed", entry, error_class=type(error).__name__, error_message=str(error),
                             duration_ns=monotonic_ns() - started, container_id=getattr(worker, "container").id,
                             generation=getattr(worker, "generation", 0))
            # Backend reset failure keeps the correct stage charged until its
            # physical owner is auditable. Failed retirement blocks the pool.
            self._retire(entry)
            raise
        with self._condition:
            entry.worker = returned
            entry.ready_at = monotonic()
            entry.state = "validated"
            self._record("reset_verified", entry, duration_ns=monotonic_ns() - started,
                         attempt_id=getattr(worker, "attempt_id"), generation=getattr(worker, "generation", 0),
                         container_id=getattr(worker, "container").id)
            self._condition.notify_all()
        return True

    def publish(self, owner_id: str, generation: int) -> None:
        """Make a verified return claimable after terminal evidence is durable."""
        with self._condition:
            entry = self._entries.get(owner_id)
            if (entry is None or entry.state != "validated"
                    or getattr(entry.worker, "generation", 0) != generation):
                return
            entry.state = "ready" if entry.retire_reason is None else "retiring"
            entry.interests.clear()
            self._record("returned", entry, generation=generation,
                         container_id=getattr(getattr(entry.worker, "container", None), "id", None))
            self._condition.notify_all()
        if entry.retire_reason is not None:
            self._retire(entry)

    def cancel(self, attempt_id: str, *, wait: bool = False, retire_ready: bool = True) -> None:
        """Cancel this interest; a preparation shared by another task survives."""
        retiring = []
        affected = []
        with self._condition:
            self._cancelled.add(attempt_id)
            for entry in self._entries.values():
                previously_cancelled = (entry.retire_reason == "cancelled" and not entry.interests
                                        and self._offered.get(attempt_id) == entry.key)
                if attempt_id not in entry.interests and not previously_cancelled:
                    continue
                entry.interests.discard(attempt_id)
                if not entry.interests:
                    entry.retire_reason = "cancelled"
                    affected.append(entry)
                    if retire_ready and entry.state in {"ready", "validated", "blocked"}:
                        entry.state = "retiring"
                        retiring.append(entry)
            self._condition.notify_all()
        # Stop long preparation/reset helpers without holding the pool lock.
        # Shared interests keep their preparation and reservation intact.
        if self._interrupt is not None:
            for entry in affected:
                if entry.state in {"preparing", "resetting"}:
                    self._interrupt(entry.owner_id)
        for entry in retiring:
            self._retire(entry)
        if wait:
            self._wait_retired(affected)

    def evict_idle(self, reason: str = "resource_pressure") -> None:
        """Drain speculative resources before a demand stage reserves its peak."""
        with self._condition:
            entries = [entry for entry in self._entries.values()
                       if not (reason == "resource_pressure" and
                               (getattr(entry.worker, "parked", False) or entry.state in {"resetting", "claiming"}
                                or entry.waiting_attempt is not None))]
            retiring = []
            for entry in entries:
                entry.retire_reason = reason
                if entry.state in {"ready", "validated", "blocked"}:
                    entry.state = "retiring"
                    retiring.append(entry)
            self._condition.notify_all()
        for entry in retiring:
            self._retire(entry)
        self._wait_retired(entries)

    @contextmanager
    def demand(self):
        """Hold off new offers throughout demand-stage resource admission."""
        with self._condition:
            self._demand_waiters += 1
        try:
            self.evict_idle()
            yield
        finally:
            with self._condition:
                self._demand_waiters -= 1

    def _wait_retired(self, entries: list[_Entry[T]]) -> None:
        with self._condition:
            while any(entry.owner_id in self._entries and entry.state != "blocked" for entry in entries):
                self._condition.wait()
            if any(entry.state == "blocked" for entry in entries):
                raise RuntimeError("Worker pool cleanup left residual resources")

    def _retire(self, entry: _Entry[T]) -> None:
        started = monotonic_ns()
        with runtime_phase(f"{self._role}.pool_cleanup", role=self._role):
            try:
                clean = self._cleanup(entry.owner_id)
            except Exception:
                clean = False
        with self._condition:
            if clean:
                self._entries.pop(entry.owner_id, None)
            else:
                entry.state = "blocked"
            self._record("retired" if clean else "cleanup_blocked", entry, reason=entry.retire_reason,
                         cleanup_duration_ns=monotonic_ns() - started)
            self._condition.notify_all()

    def _expire(self) -> None:
        while not self._stop.wait(min(1, self._idle_seconds)):
            with self._condition:
                expired = [entry for entry in self._entries.values()
                           if entry.state == "ready" and monotonic() - entry.ready_at >= self._idle_seconds]
                for entry in expired:
                    entry.state = "retiring"
                    entry.retire_reason = "expired"
            for entry in expired:
                self._retire(entry)

    def close(self) -> None:
        """Stop replenishment and prove every unclaimed resource was retired."""
        self._stop.set()
        self._sweeper.join()
        try:
            self.evict_idle("shutdown")
        finally:
            self._executor.shutdown(wait=True)
