# RepoFixLab Dataset Preparer

This one-shot service materializes the pinned SWE-bench Multilingual JavaScript/TypeScript dataset into three generation-scoped volumes:

- `public`: issue text and base revision only;
- `control`: derived sampling integers only;
- `private`: gold/test patches and official test lists.

The publication protocol is fail closed. All source rows are validated in memory first, all content files and cross-volume references are verified, identical `READY` markers are written, and identical `SEAL` markers are written last. A `DatasetLock` is emitted on stdout only after every volume verifies. Partial staging volumes are intentionally retained without a consumable lock. Existing or sealed volumes are never overwritten.

The CLI has two explicit subcommands: `prepare` performs dataset I/O and publication, while `self-check` only inspects the container runtime contract. There is no legacy command form.

```text
python -m repofix_dataset_preparer prepare \
  --source-url <pinned-url> \
  --source-sha256 <frozen-sha256> \
  --generation-id <generation> \
  --public-volume <name> \
  --control-volume <name> \
  --private-volume <name>

python -m repofix_dataset_preparer self-check
```

The production `prepare` command requires three distinct read-write mount points at `/data/public`, `/data/control`, and `/data/private`. It does not have Docker socket or model credentials. The wrapper is responsible for creating fresh named volumes, capturing stdout as the proposed lock, validating the lock against the shared v1 JSON Schema, and remounting sealed generations read-only. The preparer cannot prove from inside its mount namespace that a mount is a Docker managed volume rather than a bind mount; Compose and the bootstrap/formal socket-topology gates own that boundary.

`self-check` accepts no source, generation, or volume arguments and never invokes a source loader or the generation writer. It emits one canonical JSON report and exits nonzero unless the image ID is a lowercase `sha256:` ID, UID and GID are both `65532`, pyarrow is exactly `25.0.0`, all three `/data` directories exist, both known Docker socket paths are absent, and `ZHIPU_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `DOCKER_HOST` are absent. Only sensitive environment variable names are reported; values are never emitted. `report_sha256` binds the canonical report excluding the hash field itself.

The accepted source is an immutable JSONL or Parquet object pinned by both the dataset revision and an independently supplied SHA-256. The Parquet adapter uses the exact dependency in `requirements.lock`. Unknown or missing upstream fields fail preparation; no fallback to a floating revision is implemented.

The frozen filter is the seven JS/TS repositories registered by the design and must produce exactly 43 unique tasks, cover every registered repository, and contain `axios__axios-5892`. Rows must provide `instance_id`, `repo`, `problem_statement`, `base_commit`, `patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, and `version`; `environment_setup_commit` and `language` are validated when present. This explicit adapter boundary is intentional: an upstream schema change stops publication instead of guessing how a field should be interpreted.
