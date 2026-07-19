from __future__ import annotations

import unittest

from repofix_dataset_preparer.diff import count_changed_hunk_records
from repofix_dataset_preparer.errors import PreparationError


class DiffParserTest(unittest.TestCase):
    def test_counts_only_hunk_body_records(self) -> None:
        patch = (
            "diff --git a/a.js b/a.js\n"
            "--- a/a.js\n"
            "+++ b/a.js\n"
            "@@ -1,2 +1,3 @@ function x()\n"
            " same\n"
            "-old\n"
            "+new\n"
            "+extra\n"
        )
        self.assertEqual(count_changed_hunk_records(patch), 3)

    def test_rejects_declared_count_mismatch(self) -> None:
        with self.assertRaises(PreparationError):
            count_changed_hunk_records("@@ -1,2 +1,2 @@\n-old\n+new\n")


if __name__ == "__main__":
    unittest.main()
