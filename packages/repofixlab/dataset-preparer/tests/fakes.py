from __future__ import annotations

from typing import Any

from repofix_dataset_preparer.constants import (
    EXPECTED_REPO_COUNTS,
    EXPECTED_SOURCE_RECORD_COUNT,
)


def make_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    for repo, count in EXPECTED_REPO_COUNTS.items():
        for repo_index in range(count):
            instance_id = f"fixture__task-{index:02d}"
            display_index = index
            if repo == "axios/axios" and repo_index == 0:
                instance_id = "axios__axios-5892"
                display_index = 0
            rows.append({
                "instance_id": instance_id,
                "repo": repo,
                "problem_statement": f"Fix issue {display_index}.\r\nPreserve behavior.",
                "base_commit": f"{index + 1:040x}",
                "patch": (
                    f"diff --git a/file{index}.js b/file{index}.js\n"
                    f"--- a/file{index}.js\n"
                    f"+++ b/file{index}.js\n"
                    "@@ -1 +1 @@\n"
                    "-old\n"
                    "+new\n"
                ),
                "test_patch": (
                    f"diff --git a/test{index}.js b/test{index}.js\n"
                    f"--- a/test{index}.js\n"
                    f"+++ b/test{index}.js\n"
                    "@@ -1 +1 @@\n"
                    "-old test\n"
                    "+new test\n"
                ),
                "FAIL_TO_PASS": [f"test regression {index}"],
                "PASS_TO_PASS": [f"test stable {index}"],
                "version": "1.0",
                "environment_setup_commit": "",
            })
            index += 1
    while len(rows) < EXPECTED_SOURCE_RECORD_COUNT:
        rows.append(
            {
                "instance_id": f"python__task-{len(rows):03d}",
                "repo": "django/django",
            }
        )
    return rows
