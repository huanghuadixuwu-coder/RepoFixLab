from __future__ import annotations

import unittest
import json
from pathlib import Path

from repofixlab_evaluator.errors import TapParseError
from repofixlab_evaluator.tap import parse_tap


class TapParserTests(unittest.TestCase):
    def test_parses_the_frozen_official_tap_shape(self) -> None:
        fixture_root = Path(__file__).parent / "fixtures"
        result = parse_tap((fixture_root / "axios-tap-golden.log").read_bytes())
        expected = json.loads((fixture_root / "axios-tap-golden.json").read_text(encoding="utf-8"))
        self.assertEqual(result.status_map, expected["status_map"])
        self.assertEqual(sorted(result.skipped_tests), expected["skipped_tests"])

    def test_preserves_official_test_names_and_tracks_skip_separately(self) -> None:
        result = parse_tap(b"ok 1 optional compression # SKIP unavailable\n")
        self.assertEqual(result.status_map, {"optional compression # SKIP unavailable": "passed"})
        self.assertEqual(result.skipped_tests, {"optional compression # SKIP unavailable"})

    def test_rejects_duplicate_results(self) -> None:
        with self.assertRaises(TapParseError):
            parse_tap(b"ok 1 duplicate\nok 2 duplicate\n")

    def test_does_not_accept_near_match_lines(self) -> None:
        result = parse_tap(b"ok: 1 wrong\nnot ok 2\n ok 3 accepted \n")
        self.assertEqual(result.status_map, {"accepted": "passed"})


if __name__ == "__main__":
    unittest.main()
