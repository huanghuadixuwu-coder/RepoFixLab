from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import TapParseError

TAP_PATTERN = r"^(ok|not ok) (\d+) (.+)$"
_TAP_RESULT = re.compile(TAP_PATTERN)
_SKIP_DIRECTIVE = re.compile(r"(?:^|\s)#\s*SKIP(?:\s|$)", re.IGNORECASE)


@dataclass(frozen=True)
class TapParseResult:
    status_map: dict[str, str]
    skipped_tests: frozenset[str]


def parse_tap(log: bytes) -> TapParseResult:
    try:
        text = log.decode("utf-8")
    except UnicodeDecodeError as error:
        raise TapParseError("test log is not UTF-8") from error
    status_map: dict[str, str] = {}
    skipped: set[str] = set()
    for line in text.splitlines():
        match = _TAP_RESULT.match(line.strip())
        if match is None:
            continue
        status, _test_number, test_name = match.groups()
        parsed_status = "passed" if status == "ok" else "failed"
        previous = status_map.get(test_name)
        if previous is not None and previous != parsed_status:
            raise TapParseError("TAP contains contradictory duplicate test results")
        if previous is not None:
            raise TapParseError("TAP contains duplicate test results")
        status_map[test_name] = parsed_status
        if _SKIP_DIRECTIVE.search(test_name) is not None:
            skipped.add(test_name)
    return TapParseResult(status_map=status_map, skipped_tests=frozenset(skipped))
