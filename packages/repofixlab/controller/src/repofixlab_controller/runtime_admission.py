"""Bound attempt queues and reserve complete stage peaks before Docker work."""

from __future__ import annotations

from collections import deque
from threading import Condition
from time import monotonic

from .runtime_timing import runtime_phase


class RuntimeAdmissionBusy(RuntimeError):
    """The bounded admission queue has no free waiting position."""


class RuntimeAdmissionCancelled(RuntimeError):
    """The attempt was cancelled before obtaining its reservation."""


class RuntimeAdmissionTimeout(RuntimeAdmissionBusy):
    """An attempt exceeded its monotonic admission deadline."""


class RuntimeAdmission:
    """FIFO admission for slots or CPU/memory, with attempt-scoped cancellation.

    Reservations cover running roles and transient helpers. Verified stopped
    containers retain a zero-compute pool reservation until audited retirement.
    """

    def __init__(self, nano_cpus: int, memory_bytes: int, *,
                 baseline_nano_cpus: int = 0, baseline_memory_bytes: int = 0,
                 max_active: int | None = None, max_waiting: int = 2,
                 timeout_seconds: float = 300) -> None:
        if (min(nano_cpus, memory_bytes, baseline_nano_cpus, baseline_memory_bytes, max_waiting) < 0
                or baseline_nano_cpus > nano_cpus or baseline_memory_bytes > memory_bytes
                or (max_active is not None and max_active < 1) or timeout_seconds <= 0):
            raise ValueError("invalid runtime admission limits")
        self._condition = Condition()
        self._limits = (nano_cpus, memory_bytes)
        self._baseline = (baseline_nano_cpus, baseline_memory_bytes)
        self._max_active = max_active
        self._max_waiting = max_waiting
        self._timeout = timeout_seconds
        self._active: dict[str, tuple[int, int]] = {}
        self._waiting: deque[str] = deque()
        self._cancelled: set[str] = set()

    @property
    def snapshot(self) -> dict[str, int]:
        with self._condition:
            return {"active": len(self._active), "waiting": len(self._waiting),
                    "nano_cpus": self._baseline[0] + sum(item[0] for item in self._active.values()),
                    "memory_bytes": self._baseline[1] + sum(item[1] for item in self._active.values())}

    def acquire(self, attempt_id: str, nano_cpus: int = 0, memory_bytes: int = 0) -> None:
        """Reserve once, waiting fairly within a fixed queue and deadline."""
        if (min(nano_cpus, memory_bytes) < 0
                or nano_cpus + self._baseline[0] > self._limits[0]
                or memory_bytes + self._baseline[1] > self._limits[1]):
            raise ValueError("runtime stage exceeds the total resource budget")
        deadline = monotonic() + self._timeout
        with self._condition:
            if attempt_id in self._active or attempt_id in self._waiting:
                raise RuntimeError("attempt already has an admission reservation")
            if attempt_id in self._cancelled:
                raise RuntimeAdmissionCancelled("runtime_queue_cancelled")
            if not self._waiting and self._fits(nano_cpus, memory_bytes):
                self._active[attempt_id] = (nano_cpus, memory_bytes)
                return
            if len(self._waiting) >= self._max_waiting:
                raise RuntimeAdmissionBusy("runtime_queue_full")
            self._waiting.append(attempt_id)
            try:
                with runtime_phase("queue.resource_wait"):
                    while True:
                        if attempt_id in self._cancelled:
                            raise RuntimeAdmissionCancelled("runtime_queue_cancelled")
                        remaining = deadline - monotonic()
                        if remaining <= 0:
                            raise RuntimeAdmissionTimeout("runtime_queue_timeout")
                        if self._waiting[0] == attempt_id and self._fits(nano_cpus, memory_bytes):
                            self._active[attempt_id] = (nano_cpus, memory_bytes)
                            return
                        self._condition.wait(remaining)
            finally:
                self._waiting.remove(attempt_id)
                self._condition.notify_all()

    def _fits(self, nano_cpus: int, memory_bytes: int) -> bool:
        return ((self._max_active is None or len(self._active) < self._max_active)
                and self._baseline[0] + sum(item[0] for item in self._active.values()) + nano_cpus <= self._limits[0]
                and self._baseline[1] + sum(item[1] for item in self._active.values()) + memory_bytes <= self._limits[1])

    def try_acquire(self, owner_id: str, nano_cpus: int, memory_bytes: int) -> bool:
        """Admit speculative warming only when it cannot overtake queued work."""
        if min(nano_cpus, memory_bytes) < 0:
            raise ValueError("invalid runtime reservation")
        with self._condition:
            if owner_id in self._active or owner_id in self._waiting:
                raise RuntimeError("owner already has an admission reservation")
            if owner_id in self._cancelled or self._waiting or not self._fits(nano_cpus, memory_bytes):
                return False
            self._active[owner_id] = (nano_cpus, memory_bytes)
            return True

    def transfer(self, owner_id: str, attempt_id: str, *,
                 nano_cpus: int | None = None, memory_bytes: int | None = None) -> None:
        """Atomically transfer or resize a role stage reservation.

        The old reservation remains charged during bounded expansion waits. A
        cancelled claim leaves physical ownership intact for audited retirement.
        Callers may shrink compute only after confirming the role is stopped.
        """
        deadline = monotonic() + self._timeout
        with self._condition:
            if attempt_id in self._cancelled:
                raise RuntimeAdmissionCancelled("runtime_queue_cancelled")
            if ((attempt_id != owner_id and attempt_id in self._active)
                    or attempt_id in self._waiting or owner_id not in self._active):
                raise RuntimeError("invalid runtime reservation transfer")
            current = self._active[owner_id]
            requested = (current[0] if nano_cpus is None else nano_cpus,
                         current[1] if memory_bytes is None else memory_bytes)
            if (min(requested) < 0 or any(requested[i] + self._baseline[i] > self._limits[i] for i in (0, 1))):
                raise ValueError("runtime stage exceeds the total resource budget")
            queued = False
            try:
                with runtime_phase("queue.stage_expansion"):
                    while True:
                        if attempt_id in self._cancelled:
                            raise RuntimeAdmissionCancelled("runtime_queue_cancelled")
                        fits = all(self._baseline[i] + sum(item[i] for item in self._active.values())
                                   - current[i] + requested[i] <= self._limits[i] for i in (0, 1))
                        # Retained stages must be able to finish and drain;
                        # cold waiters may depend on this very reservation.
                        if fits:
                            del self._active[owner_id]
                            self._active[attempt_id] = requested
                            return
                        if not queued:
                            if len(self._waiting) >= self._max_waiting:
                                raise RuntimeAdmissionBusy("runtime_queue_full")
                            self._waiting.append(attempt_id)
                            queued = True
                        remaining = deadline - monotonic()
                        if remaining <= 0:
                            raise RuntimeAdmissionTimeout("runtime_queue_timeout")
                        self._condition.wait(remaining)
            finally:
                if queued:
                    self._waiting.remove(attempt_id)
                self._condition.notify_all()

    def release(self, attempt_id: str) -> None:
        """Release only after the caller proves no managed resources remain."""
        with self._condition:
            self._active.pop(attempt_id, None)
            self._condition.notify_all()

    def cancel(self, attempt_id: str) -> None:
        """Wake only this attempt; cleanup retains any active reservation."""
        with self._condition:
            self._cancelled.add(attempt_id)
            self._condition.notify_all()

    def check_cancelled(self, owner_id: str) -> None:
        """Fence Docker creation that raced an owner's cancellation."""
        with self._condition:
            if owner_id in self._cancelled:
                raise RuntimeAdmissionCancelled("runtime_queue_cancelled")
