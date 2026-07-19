from __future__ import annotations

import re

from .errors import PreparationError

_HUNK_HEADER = re.compile(
    r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$"
)


def count_changed_hunk_records(patch: str) -> int:
    """Count added/deleted hunk body records, validating declared hunk sizes."""
    if not patch:
        raise PreparationError("gold patch is empty")

    lines = patch.splitlines()
    index = 0
    changed = 0
    hunk_count = 0

    while index < len(lines):
        match = _HUNK_HEADER.match(lines[index])
        if match is None:
            index += 1
            continue

        hunk_count += 1
        old_expected = int(match.group(2) or "1")
        new_expected = int(match.group(4) or "1")
        old_seen = 0
        new_seen = 0
        index += 1

        while old_seen < old_expected or new_seen < new_expected:
            if index >= len(lines):
                raise PreparationError("unified diff hunk ended before declared line counts")
            line = lines[index]
            if line.startswith("@@ "):
                raise PreparationError("unified diff hunk overlaps the next hunk")
            if line.startswith("\\ No newline at end of file"):
                index += 1
                continue
            if not line:
                raise PreparationError("unified diff contains an unprefixed empty hunk record")

            prefix = line[0]
            if prefix == " ":
                old_seen += 1
                new_seen += 1
            elif prefix == "-":
                old_seen += 1
                changed += 1
            elif prefix == "+":
                new_seen += 1
                changed += 1
            else:
                raise PreparationError(f"invalid unified diff hunk record prefix: {prefix!r}")

            if old_seen > old_expected or new_seen > new_expected:
                raise PreparationError("unified diff hunk exceeds declared line counts")
            index += 1

    if hunk_count == 0:
        raise PreparationError("gold patch contains no unified diff hunks")
    return changed
