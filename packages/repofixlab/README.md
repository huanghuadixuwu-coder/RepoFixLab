# RepoFixLab

RepoFixLab is the containerized code-repair agent and evaluation platform described in
[`docs/designs/repofixlab.md`](../../docs/designs/repofixlab.md). This private workspace package owns the Node
orchestrator, versioned cross-language contracts, experiment state, metrics, and static reports.

The current implementation milestone establishes the v1 contract boundary, containerized bootstrap and smoke
doctors, and the sealed task-environment publication path.
TypeBox definitions under `src/contracts` are the source of truth; generated JSON Schema documents under
`schemas/v1` are enforced by both the Node orchestrator and the trusted Python Controller.

## Bootstrap doctor

From the repository root:

```bash
docker compose --profile dataset-prepare build controller orchestrator dataset-preparer
docker compose up -d --force-recreate controller
docker compose run --rm orchestrator doctor --profile bootstrap --output m0/bootstrap-doctor-<unique-id>.json
```

The command returns `0` only when every bootstrap fact is explicitly verified. A failed gate still writes a
schema-valid report and returns `1`. Output paths are constrained beneath the `/artifacts` bind mount, reject
symbolic-link traversal, and are immutable once published. The `formal` profile remains unavailable and fails
closed.

The Controller is the only Docker socket owner. Socket access is equivalent to Docker daemon root authority, so the
Controller is a trusted control-plane component; container filesystem and capability restrictions do not sandbox
that authority. A bootstrap report passes socket ownership only for real inspected role containers. Missing roles
remain unverified.

The one-shot `dataset-prepare` profile runs as UID 65532 without the Docker socket or model credentials. It accepts
only the frozen SWE-bench Multilingual object and publishes public/control/private generation volumes through the
verified `READY`/`SEAL` protocol. A real dataset prepare is forbidden until bootstrap doctor passes.

The host entrypoint is `scripts/repofixlab.ps1 dataset prepare`. It runs bootstrap first and stops before Preparer
build, dataset download, or generation-volume creation on any No-Go. Bootstrap requires the write-once image
provenance lock and checks its Controller and Orchestrator image/config identities against live observations.

## Task-environment lock and Smoke Doctor

Both commands accept one manifest path beneath `/artifacts`; they never accept individual evidence paths from
caller-controlled flags:

```bash
docker compose run --rm orchestrator environment-lock-create \
  --input m0/environment-lock-evidence-manifest.json \
  --output m0/task-environment-lock.json

docker compose run --rm orchestrator doctor --profile smoke \
  --input m0/smoke-doctor-evidence-manifest.json \
  --output m0/smoke-doctor-report.json
```

The environment-lock manifest names the DatasetLock, official image lock, raw official harness source lock,
candidate, FactoryProbeReport, HarnessEquivalenceReport, raw PristineRuntimeLock, and the four pristine plus four
adapted probe reports. All 15 resolved files must be distinct. Publication verifies the exact UTF-8 file hashes and
semantic seals, reconstructs the Factory request from the report operation ID, and recomputes harness equivalence
from all eight reports before writing the immutable `TaskEnvironmentLock` with mode `0644`.

The Smoke manifest names exactly four files: the bootstrap doctor report, bootstrap provenance lock,
TaskEnvironmentLock, and the same environment-lock evidence manifest. The manifest itself, those four files, and
the nested 15 evidence files must resolve to 20 distinct paths. Smoke additionally checks Controller execution
identity and its exact mount allowlist, bootstrap-to-factory ordering, cleanup residuals, and the complete
four-scenario/two-harness matrix. The report is written with mode `0600`; exit `0` means every hard gate passed and
exit `1` means a schema-valid fail report. CLI syntax errors return `2`, and an unavailable lifecycle profile returns
`3`. Missing, aliased, or malformed JSON input fails before output publication; readable but unverifiable evidence
can only produce a hash-sealed fail report.

## Task-role factory RPC

When `REPOFIXLAB_FACTORY_CANDIDATE_DIR` points to a read-only trusted mount, Controller startup loads and verifies
the candidate catalog and enables `POST /v1/factory/task-role-probes`. The request body contains exactly
`operation_id`, `candidate_id`, and `instance_id`; image IDs, commands, mounts, security options, and Docker
parameters are never accepted from the caller. Factory state is persisted under
`REPOFIXLAB_FACTORY_OPERATION_ROOT` (default `/var/lib/repofix/controller/factory-operations`) with an append-only
hash-chained journal and a write-once atomic strict report. Same-request retries replay one terminal report, while an
operation ID bound to a different request is rejected.

The current Axios smoke profile fixes `node /opt/repofixlab/role-probe.mjs`, tmpfs options, and the permitted image
environment variable names in Controller code. The exact allowlist is `CHROME_BIN`, `CHROME_PATH`,
`DEBIAN_FRONTEND`, `HOME`, `LANG`, `LC_ALL`, `NVM_DIR`, `PATH`, and `TZ`; no wildcard is accepted. Those three
controls are deliberately not claimed as fields locked by the current `TaskEnvironmentCandidate`; a future general
task profile requires a separately versioned contract. Catalog loading recomputes all six profile IDs and hashes,
the candidate ID and hash, canonical mount order, and distinct lock/image/component bindings using the TypeScript
canonical JSON-plus-LF rules. Startup inspects each exact local image and rejects identity, platform, provenance,
probe, sanitizer, instance, base-commit, sensitive-environment, or environment-allowlist drift before admitting any
operation. The adapter hash remains candidate-bound and is not claimed as an image label.

## Contract workflow

```bash
npm run generate-schemas
npm run check:schemas
npm test
```

Generated schemas are committed. `check:schemas` is read-only and fails when a generated document is missing,
stale, or unexpected.

RepoFixLab does not modify Pi's agent loop. Later milestones integrate through the public
`@earendil-works/pi-coding-agent` session API.
