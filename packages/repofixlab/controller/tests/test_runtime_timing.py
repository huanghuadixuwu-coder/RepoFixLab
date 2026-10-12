"""Timing must preserve runtime behavior and handle nesting and contention."""

from threading import Event, Lock, Thread
import unittest

from repofixlab_controller.runtime_timing import RuntimeTimings, interval_union_ns, runtime_phase, timed, timed_lock


class RuntimeTimingTests(unittest.TestCase):
    def test_background_phase_keeps_identity_without_a_synchronous_parent(self):
        recorder = RuntimeTimings()
        with recorder.recording(attempt_id="a"):
            with runtime_phase("preflight"):
                with runtime_phase("prewarm", role="worker", detached=True):
                    with runtime_phase("ready"):
                        pass
        child, background, caller = recorder.records
        self.assertEqual(background["attempt_id"], caller["attempt_id"])
        self.assertNotIn("parent_id", background)
        self.assertEqual(child["parent_id"], background["span_id"])

    def test_nested_spans_use_monotonic_intervals_once(self):
        clock = iter([100, 110, 130, 160])
        recorder = RuntimeTimings(lambda: next(clock))
        with recorder.recording(attempt_id="a"):
            with runtime_phase("worker.prepare", role="worker"):
                with runtime_phase("container.create"):
                    pass
        child, parent = recorder.records
        self.assertEqual(child["parent_id"], parent["span_id"])
        self.assertEqual(child["role"], "worker")
        self.assertEqual(child["duration_ns"], 20)
        self.assertEqual(parent["duration_ns"], 60)
        self.assertEqual(interval_union_ns(recorder.records), 60)
        self.assertEqual(interval_union_ns([{"started_ns": 10, "ended_ns": 20}, {"started_ns": 15, "ended_ns": 25}, {"started_ns": 30, "ended_ns": 40}]), 25)

    def test_result_and_original_exception_are_preserved(self):
        result = object()
        error = ValueError("original")

        @timed("operation")
        def operation(fail=False):
            if fail:
                raise error
            return result

        self.assertIs(operation(), result)
        recorder = RuntimeTimings()
        with recorder.recording():
            self.assertIs(operation(), result)
            with self.assertRaises(ValueError) as observed:
                operation(True)
        self.assertIs(observed.exception, error)
        self.assertEqual([item["outcome"] for item in recorder.records], ["completed", "failed"])
        self.assertEqual(recorder.records[1]["error_class"], "ValueError")
        operation()
        self.assertEqual(len(recorder.records), 2)

    def test_thread_scope_and_lock_wait_exclude_critical_section(self):
        recorder = RuntimeTimings()
        lock = Lock()
        ready = Event()
        acquired = Event()
        finish = Event()
        lock.acquire()

        def contender():
            with recorder.recording(attempt_id="contender"):
                ready.set()
                with timed_lock(lock):
                    acquired.set()
                    self.assertTrue(finish.wait(5))
            with runtime_phase("out_of_scope"):
                pass

        thread = Thread(target=contender)
        thread.start()
        self.assertTrue(ready.wait(5))
        self.assertFalse(acquired.wait(0.01))
        lock.release()
        self.assertTrue(acquired.wait(5))
        self.assertEqual(len(recorder.records), 1)
        self.assertEqual(recorder.records[0]["phase"], "queue.wait")
        self.assertEqual(recorder.records[0]["attempt_id"], "contender")
        self.assertGreater(recorder.records[0]["duration_ns"], 0)
        with runtime_phase("main_has_no_scope"):
            pass
        finish.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(recorder.records), 1)
        self.assertTrue(lock.acquire(blocking=False))
        lock.release()


if __name__ == "__main__":
    unittest.main()
