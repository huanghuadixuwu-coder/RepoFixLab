# Pristine SWE-bench harness image

This image is an independent official-oracle runtime. It does not run Docker,
mount the Docker socket, create task containers, or contain RepoFixLab task
orchestration. Its only executable path verifies the complete pinned source,
dependency lock, evaluator kernel, and build provenance before importing
`swebench.harness.run_evaluation` and exercising the official grading oracle.

The dependency lock contains the complete transitive closure of the upstream
SWE-bench base dependencies. This is intentional because upstream
`swebench/__init__.py` eagerly exposes collection, dataset, and Modal modules.
Inference, test, documentation, and development extras are not included.

## Materialize and build

Create the upstream archive from the exact audited commit in an existing local
SWE-bench Git checkout; this step does not use the network:

```text
git -C <swebench-checkout> archive --format=tar --output=<outside-repo>/swebench-726c5461.tar 726c5461e2ef52d83cf1ea2107870a8bb3328d57
```

Run `materialize_context.py` with CPython 3.11, passing that archive, the Pi
repository root, and a new output directory outside the repository. The script
copies only `pyproject.toml` and `swebench/`, verifies the full 591-file source
aggregate and all grading-path hashes, copies the evaluator kernel, and emits a
canonical `build-provenance.json`.

Build for `linux/amd64`, passing the emitted provenance hash:

```text
docker build --platform linux/amd64 --build-arg PROVENANCE_SHA256=<hash> --tag repofixlab/pristine-harness:m0-726c5461 <context>
```

Only the hashed-wheel dependency installation layer has network access. The
subsequent build-time self-check explicitly uses BuildKit `--network=none`.

## Restricted startup check

```text
docker run --rm --platform linux/amd64 --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=16m repofixlab/pristine-harness:m0-726c5461 self-check
```

The image needs no writable persistent volume and no Docker socket. A startup
failure is fatal; there is no bypass mode. The image is an oracle runtime only
and does not execute the four M0 equivalence probes by itself.
