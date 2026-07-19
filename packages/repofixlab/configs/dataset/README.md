# Dataset preparation configuration

`v1.yaml` is a deliberately flat, frozen configuration. The PowerShell wrapper parses this restricted `key: value` form itself, rejects unknown or duplicate keys, and checks every security-sensitive value against the compiled Dataset Preparer contract. No host YAML, Node.js, or Python runtime is required.

From the repository root:

```powershell
.\scripts\repofixlab.ps1 dataset prepare --config configs/dataset/v1.yaml
```

The wrapper first parses and statically validates the frozen configuration, including the exact generation-scoped volume-name contract. A failure at this boundary creates no operation directory or self-check directory and makes no Docker call. It then runs a uniquely named containerized bootstrap doctor. A non-zero doctor result stops before the Dataset Preparer image is built, before the three generation volumes are created, and before the dataset is downloaded. On a Go result it builds and inspects the immutable Dataset Preparer image ID, runs the image self-check without dataset mounts, and only then invokes the one-shot Compose profile.

Each invocation gets a new directory under `artifacts/dataset-prepare/`. Doctor output, build/inspect logs, the proposed `DatasetLock`, stderr, and a command transcript use create-new paths and are never overwritten. Failed staging volumes and sealed volumes are intentionally retained for audit; this wrapper never deletes them.

The current machine passes the bootstrap doctor, and one complete real prepare has succeeded. The first real attempt, `artifacts/dataset-prepare/20260718T135002385Z-7a40765a1650`, failed because the wrapper/configuration still used the cross-component legacy `repofixlab-dataset` prefix and the implementation at that time downloaded the source before validating the generated names. Its three staging volumes are intentionally retained and it published no `DatasetLock`. The fix rejects that legacy prefix before any Docker call, operation directory, self-check directory, or download; the Python suite passes 21/21 and the complete wrapper regression passes in 272.4 seconds.

The successful prepare artifact is `artifacts/dataset-prepare/20260718T135934707Z-243342d1916a`: generation `g-20260718-135934-066a8f5b6f6b`, lock ID `dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6`, 43 tasks from seven repositories including Axios, and aggregate SHA-256 `e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55`. Independent read-only Python verification, the TypeScript schema/self-check verifiers, and the final `attached=0` check for all three sealed volumes passed. RepoFixLab M0 nevertheless remains No-Go: Axios smoke, task-environment locks, Worker/Evaluator factory evidence, harness equivalence, and later gates are incomplete. The current Orchestrator provenance image also predates the newly added dataset sources, so the final provenance lock must be rebuilt, audited, and replaced before M0 exit.
