# Axios task-image pipeline

From the repository root:

```powershell
.\scripts\repofixlab.ps1 images prepare-axios
```

`v1.yaml` is a flat, frozen input contract. The host wrapper verifies every value and the hashes of both Dockerfiles, the Worker audit, the shared sanitizer, and the shared active probe before Docker work. It records the requested upstream tag as resolution provenance but pulls only the exact `repository@digest`; the tag is never passed to `docker pull` or a build. Source, Worker, and Evaluator local image IDs are observations made after pull/build, not cross-machine configuration inputs; each must be an exact SHA-256 ID and remain stable through the operation.

The pipeline independently builds `worker-sanitized.Dockerfile` and `sanitized.Dockerfile` with `--no-cache --pull=false --network none`. The Worker is the Agent workspace: it contains exactly the base commit as a one-commit shallow repository, with no parent, remote, reflog entries, or unreachable objects. Its frozen audit script is embedded by hash and executed as a root-only image gate. The Evaluator is the verification authority: it preserves only `refs/heads/repofixlab-base`, with no future commits, issue-number hits, unreachable objects, or worktree changes. The fixed Axios baseline test runs only on the Evaluator.

Each role is copied into its own uniquely named and role-labeled Docker volume. The same canonical active probe runs on both roles as `65532:65532` with `network=none`, a read-only root filesystem, dropped capabilities, no-new-privileges, and tmpfs-backed `/tmp`. The probe accepts the Controller-canonical `REPOFIX_EXPECTED_BASE_COMMIT` and `REPOFIX_EXPECTED_PROBE_SHA256` bindings and rejects a mismatch between its own file hash and the bound probe hash. M0 verifies non-root probe execution for both images; root-owned production-candidate evaluation remains a later harness gate and is explicitly recorded as pending here.

Every attempt is atomically finalized under `artifacts/task-images/<operation>/`. The result, provenance, and audit files identify Worker and Evaluator separately. Temporary containers and both validation volumes are removed in cleanup; any role residue fails the operation and blocks publication. The active OfficialImageSourceLock records only the upstream source image and is created only after every gate and cleanup pass. An existing active lock is accepted only when its independently recomputed semantic hash is identical; it is never overwritten on drift.

The frozen harness revision is SWE-bench v4.1.0 commit `726c5461e2ef52d83cf1ea2107870a8bb3328d57`, used to derive the logical image key and locked Axios test command. It does not claim that the older registry source image was built from that harness commit; source-image content is bound independently by repository digest and the pull-time local image ID.
