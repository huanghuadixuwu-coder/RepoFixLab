from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from repofixlab_evaluator.errors import PrivateSpecError
from repofixlab_evaluator.private_spec import BASE_COMMIT, INSTANCE_ID, load_private_spec

from tests.test_patches import patch_for


def private_value() -> dict[str, object]:
    return {
        "schema_version": "v1",
        "instance_id": INSTANCE_ID,
        "base_commit": BASE_COMMIT,
        "test_patch": patch_for("test/http.js").decode(),
        "gold_patch": patch_for("lib/http.js").decode(),
        "fail_to_pass": ["fixes compression"],
        "pass_to_pass": ["preserves redirects"],
    }


class PrivateSpecTests(unittest.TestCase):
    def test_loads_only_from_the_evaluator_private_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "task.json"
            path.write_text(json.dumps(private_value()), encoding="utf-8")
            spec = load_private_spec(path, root)
            self.assertEqual(spec.instance_id, INSTANCE_ID)
            self.assertEqual(spec.fail_to_pass, ("fixes compression",))

    def test_rejects_extra_fields_and_symlinked_specs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = private_value()
            value["leak"] = "gold"
            target = root / "target.json"
            target.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaises(PrivateSpecError):
                load_private_spec(target, root)
            link = root / "link.json"
            link.symlink_to(target)
            with self.assertRaises(PrivateSpecError):
                load_private_spec(link, root)


if __name__ == "__main__":
    unittest.main()
