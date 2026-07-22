# RepoFixLab M7 Protocol 1.7.3 continuation

## Scope

M7 executes the frozen 74 logical runs from the 26-task M3 eligible SWE-bench
Multilingual JS/TS pool. Every run uses the same DeepSeek V4 Flash model
revision, the same Docker task environment, and a fresh official Evaluator.
No Dev or M6 calibration result contributes to the M7 result denominator.

Protocol 1.7.2 superseded the invalid 1.7.1 batch. The earlier batch stopped
after one Provider-backed run because M7 lacked an adapter from the sealed M6
official-evaluation aggregate to the M7 RunResult evaluation contract. Its
artifacts remain read-only and are excluded from every formal denominator.

Protocol 1.7.3 retains the 13 v1.7.2 runs that completed within the original
64-turn guard. It re-executes only the failed, interrupted, and never-started
source runs: 61 new logical runs. Every v1.7.3 run uses
`max_model_turns: 128`; the 5,000,000 Token per-run admission cap, model,
task lock, evaluator, and tool contract are unchanged. Final reporting must
preserve the 64-turn and 128-turn strata rather than presenting them as one
fixed-turn comparison.

The stopped v1.7.2 run had one open Provider reservation. Its source-batch
ledger is closed conservatively as `interrupted_unreconciled_provider_request`;
it contributes neither a repair result nor a Token observation. Its logical
run is re-executed once in v1.7.3 under the 128-turn contract.

## Frozen budget

| Item | Value |
| --- | ---: |
| Original logical runs | 74 |
| v1.7.3 continuation runs | 61 |
| Per-run accounted admission cap | 5,000,000 Token |
| v1.7.3 continuation admission cap | 305,000,000 Token |
| v1.7.2 completed-run turn limit | 64 |
| v1.7.3 continuation turn limit | 128 |
| Global concurrency | 1 |
| Worker/Evaluator concurrency | 1 |

The continuation cap is exactly the sum of its 61 per-run caps. A run whose next
provider request cannot be admitted is terminal with `budget_exhausted`; it is
not retried and remains in the fixed denominator. The batch does not silently
substitute a task, configuration, replicate, prompt, or model.

## Model and estimator

- Provider/model: `deepseek` / `deepseek-v4-flash`.
- Provider key is mounted into Orchestrator only through a Docker Compose
  secret file; it is never written to artifacts or made available to
  Controller, Worker, or Evaluator.
- The M6 1.6 continuation evidence freezes estimator multiplier `1.351` and
  framing margin `4096` Token. Each request retains the 16,384 Token output
  reservation and must settle Provider usage before the next request.
- An unknown or un-reconciled Provider usage record stops the batch. It must
  never be converted into a zero-cost retry.

## Execution contract

1. Verify the M3 task-environment locks, M6 formal-doctor evidence, image
   bindings, configuration hash, and protocol lock before the first Provider
   request.
2. Execute the selected configuration in a sanitized Worker.
3. Persist the candidate snapshot, destroy the Worker, then create a fresh
   Evaluator for the same snapshot. The Worker and Evaluator never share a
   filesystem.
4. Persist and hash-bind the official evaluator artifacts before acknowledging
   their cleanup.
5. Publish an immutable result and immediately fsync its batch receipt and
   budget settlement. Resume may execute only a never-started queued run.

## Acceptance

M7 may report `pass` only when all original 74 logical runs have immutable
terminal evidence: the 13 retained v1.7.2 results plus all 61 v1.7.3
continuation results. Every completed result must have an official-evaluator
artifact set; every failure must retain terminal evidence; the v1.7.3 ledger
must require no reconciliation; and all security and image-binding gates must
remain valid. The v1.7.2 interruption ledger is explicitly excluded from
usage metrics because its last Provider request cannot be settled. A run can
be unresolved or failed; those are experiment outcomes, not grounds for
removal.

The terminal report is an immutable 74-observation join keyed by the original
logical identity. It records each observation's 64- or 128-turn stratum,
retained or continuation result SHA-256, and terminal reason. Aggregate
comparisons are allowed only within the same turn-limit stratum.
