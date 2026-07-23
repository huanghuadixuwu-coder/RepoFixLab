# RepoFix R2 execution contract

Status: active for the R2 repair, targeted validation, and RepoFix-only Full execution sequence.

`r2-immutable-2005-target-r3-v1` is invalid as a task-performance result. It exposed two implementation defects before V0: a Controller parser incorrectly required the verification-only `baseline` field on every normal `repo_*` result, converting valid worker results to HTTP 503; then the run-wide 100-tool admission gate prevented the two bounded completion-only recovery turns. The repair adds a repository-tool readiness probe during worker preparation, restores the exact normal tool-result schema, and records tool calls as observational rather than an arbitrary admission ceiling.

`repofixlab-r2-v1` is retained only as an invalid pre-Provider execution record. Its Full batch was stopped after the M4 caller detached Controller methods from their receiver; all affected attempts failed before their first Provider reservation. `repofixlab-r2-v2` is retained as a failed workflow-contract smoke: its first Full task reached LOCALIZE, but `exclusions: []` was rejected even though no exclusion existed. `repofixlab-r2-v3` then encountered the v2 worker left by the manual stop; all v3 attempts were rejected before Provider use. `repofixlab-r2-v4` verified the fail-closed batch guard by stopping after its first 429. `repofixlab-r2-v5` completed four tasks but exposed that the nominal stage-turn limit did not bind the production Pi loop; its fifth task was Controller-aborted during unbounded LOCALIZE exploration. No v1/v2/v3/v4/v5 outcome is included in R2 analysis. R2 v6's ninth-tool hard block is retired: it exposed a real control failure but also imposed an ungrounded fixed exploration limit.

## Purpose

R2 repairs a workflow-control failure observed in the M7–M9 history: a model-authored verification argv could be rejected by the Controller after P0, terminating the attempt before refinement, P1, and official evaluation. R2 preserves the Pi agent loop as execution substrate, but makes verification Controller-owned, structured, and recoverable.

Historical M7–M9 artifacts remain historical evidence. The R2 26-task matrix is a `posthoc_diagnostic`, not an unseen-task generalization claim. The next execution is only `immutable-js__immutable-js-2005`; subsequent R2 experiments are RepoFix-only. Pi is not rerun.

## Workflow

Update: the targeted `immutable-js__immutable-js-2005` execution has completed. Subsequent R2 work is RepoFix-only; Pi is not rerun.

```text
prepare worker → Controller verification catalog → PLAN selects candidate ID
  → IMPLEMENT → P0 → V0 verification → REFINE_1
  → V1 snapshot → V1 verification → REFINE_2
  → V2 snapshot → V2 verification → SELF_REVIEW → P1
  → official evaluator
```

- The Controller derives catalog entries only from preflighted `package.json` test scripts. The model receives IDs and descriptions, never argv, cwd, timeout, or cache paths.
- Each verification creates two separate temporary local Git clones with their own Git metadata. The Controller runs the selected command on the unmodified base clone and on a clone with the current snapshot patch. It shares only existing dependency artifacts when available and writes caches under `/tmp`; it never creates or removes source-repository worktrees.
- The verification record contains both baseline and patched outcomes. A refinement receives the patched outcome plus the baseline status, so it can treat a pre-existing test failure as diagnostic evidence rather than falsely claiming that its edit caused it.
- Verification always returns one of `passed`, `test_failed`, `command_invalid`, `environment_failure`, or `timed_out`; safe reason codes and bounded output reach the Agent. Full logs remain internal artifacts.
- Full and no-feedback configurations execute the same V0/V1/V2 verification rounds. The no-feedback configuration masks only the result supplied to refinement/review stages.
- RepoFix has no arbitrary `repo_exec` stage. Controller policy, mounts, and worker isolation remain the enforcement boundary.

## Provenance and evidence

Each run records the verification catalog hash, selected candidate ID, P0/V1/V2/P1 snapshots, V0/V1/V2 verification artifacts (each with baseline and patched outcome), actual RepoFix prompt/tool hashes, token ledger, trajectory, and official evaluator evidence. P1 must hash-identically equal V2 because SELF_REVIEW has no edit tool. A controller rejection is recorded with a stable `reason_code`; aggregate reports must not infer malicious intent from rejection counts.

The formal-run manifest derives identity from the actual configuration session. A RepoFix run must never record the Pi-general prompt hash.

## Targeted forensic record: `immutable-js__immutable-js-2005`

`r2-forensic-immutable-2005-v1` is a single-task diagnostic run, not a Full R2 result and not official evaluation evidence. Its control trace is retained at `artifacts/r2-forensics/immutable-2005-v1/m4-dev/runs/r2-forensic-immutable-2005-v1/repofix-control-trajectory.json`; the raw model/tool trajectory and two controlled-verification artifacts are retained beside it.

The task made useful progress before control escalation: 45 repository operations completed and IMPLEMENT produced a patch. The failure is concentrated after a stage threshold fires. Of 82 Provider requests (2,190,026 accounted tokens), 38 requests (966,998 tokens) were made after `completion_only` had been entered. In UNDERSTAND, LOCALIZE, PLAN, and REFINE_1, the model made 8, 10, 10, and 8 additional Provider requests respectively before finally submitting `stage_complete`.

This is not additional repository exploration: the Controller blocked the post-escalation `repo_*` requests. The model nevertheless repeated those requests because the current native Pi `session.prompt()` call was still alive. The recovery prompt that says "call `stage_complete` now" is issued only after that native loop returns, so its nominal two-attempt bound does not bound these internal turns. Rejected tool calls also count towards the run-wide admission gate. In REFINE_2, the ninth repository request triggered the stage limit, then the outer 100-tool admission gate returned `repofixlab_tool_call_limit_reached` before a completion-only Provider request could occur; the stage therefore had no artifact and the diagnostic run stopped before P1/evaluation.

The sealed-handoff hypothesis remains a secondary investigation item, not a confirmed cause. The prior-stage structured handoff grew from 1,317 to 5,547 characters. The captured session context grew to 437,177 characters, but this telemetry was measured before `stageCompletionContext()` replaces earlier repository results, so it is not a measurement of the actual Provider payload. The trace does establish that the large post-threshold cost is the blocked-tool retry loop, rather than evidence that the handoff summary itself caused it.

Both P0 and V1 controlled verification attempts returned `environment_failure` with `verification_worktree_unavailable`: Git could not create `.git/worktrees/worktree` due to permission denial. No test command ran, so the Agent received no semantic verification feedback in this diagnostic.

The repair changes the execution contract as follows: (1) RepoFix exposes Pi's native `shouldStopAfterTurn` hook and requests a stop after every completion-only recovery turn; (2) missing or rejected `stage_complete` artifacts receive exactly two completion-only Provider turns, then terminate deterministically; (3) eight model turns or eight repository calls are trajectory-only checkpoints, not tool blocks; (4) stage tool permissions still block calls outside the active stage and record those escapes separately; (5) verification uses isolated local clones rather than source worktree metadata; (6) provider-context telemetry is recorded after prior repository results are sealed; (7) structured handoffs are bounded valid JSON projections, never character-sliced JSON; (8) worker preparation executes a Controller-owned `repo_list` readiness probe, and normal tool results are parsed only against the normal tool-result schema; and (9) `max_tool_calls` is null for this R2 workflow, while token, model-turn, provider-request timeout, and wall-time ceilings remain enforced.

`r2-immutable-2005-target-r3-v3` satisfied that targeted gate: V0/V1/V2 executed with baseline and candidate outcomes, V2 and P1 matched, and the official evaluation resolved the task (2/2 fail-to-pass and 20/20 pass-to-pass). It is a valid diagnostic proof that the repaired workflow can complete this task, not a 26-task aggregate claim.

## Post-repair Full execution isolation

The historical `artifacts/r2-v6/full` state is not resumable evidence: it contains three results produced before the repair, an interrupted state, and a stale five-million-token reservation. A repaired Full execution uses `REPOFIX_R2_EXECUTION_ARTIFACT_DIRECTORY=r2-v6-r3`. This creates a separate immutable root for the batch state, global budget, formal result artifacts, M4 snapshots, V0/V1/V2 records, trajectories, and official evaluations. It retains the frozen `repofixlab-r2-v6` plan and deterministic logical run IDs, so result identity is unchanged while storage provenance is unambiguous.

The Full continuation records `immutable-js__immutable-js-2005` as completed through an immutable source-result receipt that binds its diagnostic run manifest, result, and official evaluation. It executes only the other 25 frozen Full tasks. This is intentionally reported as 25 directly executed tasks plus one carried-forward targeted result, not as a homogeneous one-run 26-task matrix.

## Controller identity isolation and three-task recovery

The three `r2-v6-r3/full` failures (`mrdoob__three.js-26589`, `preactjs__preact-4245`, and `preactjs__preact-4316`) are not task-performance observations. The artifact root was new, but batch attempt IDs were still derived only from the deterministic logical `run_id`. They therefore reused historical Controller attempt and lifecycle operation identities from `r2-v6/full`. The Controller persists operation IDs globally in its journal: matching requests replay old lifecycle responses, while a differing request or an inactive historical worker returns HTTP 409. The first two tasks inherited historically completed attempts; the third inherited a historical interrupted attempt. Repository operations failed from the first call, before the model had a usable repository environment.

The repair binds every Controller attempt ID to a persisted execution namespace and derives Controller-facing `repo_*` operation IDs from both that attempt ID and the model tool-call ID. A repeated request within one attempt remains idempotent; an identical logical task in another execution cannot replay its historical lifecycle. Worker preparation also performs a Controller-owned `repo_list` probe before any Provider request. A probe failure is a pre-Provider infrastructure failure and stops the batch rather than letting the model loop on 409 tool errors. Runtime error artifacts retain the Controller's structured 409 detail.

The recovery is restricted to the three affected Full logical runs and is stored in a separate root, `r2-v6-r4/controller-identity-3`. It writes a `recovery-cohort.json` declaration that identifies the original `r2-v6-r3/full` outcomes as `infrastructure_failure`. The existing 19 direct Full results and the carried immutable-js result are immutable and are neither rerun nor overwritten. Recovery outcomes are first reported separately; a later aggregate may substitute them only under the explicit label “corrected R2 Full”.

## R2 matrix and release criteria

## Official-unresolved workflow remediation

The corrected R2 Full accounting is 22 official resolved and 4 official unresolved across 26 frozen Full tasks: the 19 directly resolved R3 Full tasks, the carried immutable-js result, and two Controller-identity recovery results are all resolved; the three original R3 official unresolved results plus the valid `preactjs__preact-4316` recovery result remain unresolved. The recovery replaces only the three Controller identity infrastructure failures and does not overwrite any historical artifact.

All four unresolved results applied their candidate patch and executed official tests, so none is classified as an evaluator or external-platform failure. The shared workflow evidence is that V0/V1/V2 did not yield usable semantic feedback: the selected commands encountered resource exhaustion, clone/package resolution failure, or a missing build artifact and unwritable cache. Equal baseline and candidate failure is non-comparative evidence, not proof that a patch is correct.

The remediation changes RepoFix only:

- the Controller derives a fixed `npm run build` prerequisite when immutable `package.json` metadata declares a missing package entrypoint and a build script; it runs this in each isolated clone before the Controller-owned selected test command;
- verification uses a per-clone writable Babel cache and classifies known resource, cache, artifact, and shared resolver failures as `environment_failure` with a stable reason code;
- PLAN must record repository-evidenced neighboring behavior invariants and callback/re-entry/deferred-state transition checks; REFINE and SELF_REVIEW must explicitly discharge, narrow, or retain credible risks rather than accepting them as rare or treating a failed baseline as proof.

`REPOFIX_R2_RECOVERY_COHORT=semantic-workflow-4` is the only permitted targeted remediation batch for valid official-unresolved outcomes. It contains exactly `preactjs__preact-3062`, `preactjs__preact-3345`, `preactjs__preact-3567`, and `preactjs__preact-4316`, runs under a new execution root, and writes a separate `recovery-cohort.json`. Its outcomes are reported separately as workflow-remediation evidence and never overwrite or relabel the prior 22/4 result.

### `semantic-workflow-4` outcome and follow-up

`r2-v6-r5/semantic-workflow-4` is complete. It is an explicitly labelled targeted remediation cohort, not a replacement for the historic corrected R2 Full result. Of the four valid official-unresolved inputs, `preactjs__preact-3062` is now official resolved; `preactjs__preact-3345`, `preactjs__preact-3567`, and `preactjs__preact-4316` remain official unresolved. The cohort result is therefore **4 unresolved -> 3 unresolved**. The historic R2 Full accounting remains **22 resolved / 4 unresolved**; a hypothetical substituted accounting would be 23/3, but must not be reported as the original R2 Full result.

All four runs produced P0/V1/V2/P1 and ran the official evaluator. The three remaining failures are RepoFix repair-quality failures, not evaluator, Controller-identity, worker-preparation, or official-platform failures. Verification infrastructure still reduced feedback quality in places, but that does not invalidate their official results:

- `preactjs__preact-4316`: F2P 1/1 and P2P 9/10. The patch lowercased every fallback event name. It fixed `onFocusIn`/`onFocusOut` but regressed a CamelCase custom event. The PLAN and SELF_REVIEW both named that exact risk, then accepted it as rare.
- `preactjs__preact-3345`: F2P 0/1 and P2P 16/16. The final patch continued traversing unmount cleanups after an error, but did not clear a cleanup handle before invocation and did not implement the complete error/cleanup ordering required by the task.
- `preactjs__preact-3567`: F2P 0/1 and P2P 20/20. The patch removed a reset of `_args`; it did not separate tentative render data from committed hook state, so it did not implement the required re-entry/deferred-state semantics.

`preactjs__preact-3062` is the completed remediation. Its final patch adds only `name !== 'tabIndex'` to the existing DOM-property exclusion list. `tabIndex` therefore falls through to the already-correct attribute path: numeric values remain attributes and nullish values remove the attribute rather than coercing an empty property value to `0`. The official result is F2P 1/1 and P2P 66/66. This validates the intended RepoFix method: localize the coercion boundary, state which neighbouring property paths must remain unchanged, and change only the exceptional path instead of generalizing a null-handling rule.

The cohort also exposes three workflow defects that must be repaired before another semantic remediation cohort:

1. **Narrative risk disposition is not a safety gate.** A stage artifact can label a known observable regression "rare" or "acceptable" and still permit P1. For `4316`, a preservation invariant must become a concrete counterexample: standard `onFocusIn`/`onFocusOut` use lower-case DOM event names, while unrecognised custom-event suffixes retain their original case. The expected patch is a narrow focus-in/focus-out handling rule, not fallback lowercasing. Completion must fail when a planned preserved behavior is contradicted by the proposed diff or lacks a matching test/evidence disposition.
2. **PLAN-to-diff coverage is not enforced.** For `3345`, PLAN committed to four cleanup/effect contexts but P1 changed only unmount; SELF_REVIEW did not flag the missing plan steps. RepoFix must record a disposition for every planned code site at IMPLEMENT and SELF_REVIEW (`implemented`, `ruled_out by repository evidence`, or `blocked`), and reject stage completion if any site is silently dropped. The expected semantic patch must clear the cleanup reference before invoking it, continue the required cleanup traversal, and report the captured error only at the specified post-traversal boundary; it must apply that ordering to each repository-evidenced context, not merely unmount.
3. **Controlled verification admits non-terminating and non-comparative commands as false confidence.** `test:karma:hooks` contains `--no-single-run`: tests can finish but the process does not exit, so V0/V1/V2 become `timed_out`. Other selected broad `npm test` commands hit parallel-build `EAGAIN`. The Controller catalog must expose only deterministically terminating candidates, or derive and preflight a Controller-owned single-run variant from immutable script metadata. A verification is usable only when its test process exits normally; partial green output from `timed_out` is non-comparative. For `3567`, the expected semantic patch must model committed versus pending hook args/value separately and commit pending state only after the render path is stable; targeted re-entry tests must cover `setState` during render, dependency changes, effect cleanup, layout effects, and memo state.

`r2-v6-r9/semantic-workflow-followup-3` then reran the three remaining logical tasks in a new labelled cohort. `preactjs__preact-4316` is official resolved with F2P 1/1 and P2P 10/10; it replaces the earlier P2P 9/10 remediation result only in the explicitly labelled latest replacement view. `preactjs__preact-3567` remains official unresolved with F2P 0/1 and P2P 20/20. `preactjs__preact-3345` failed its new SELF_REVIEW invariant-disposition coverage check before P1, so R9 retained no official evaluation for that task and cannot be treated as a semantic outcome.

`r2-v6-r12/self-review-recovery-3345-1` subsequently recovered only that workflow-completion failure. It retained P0/V1/V2/P1 and ran official evaluation: F2P 0/1 and P2P 16/16. This is a valid semantic unresolved result, not an environment or workflow failure. The latest explicitly substituted R2 view is therefore **24 resolved / 2 semantic unresolved** across the 26 frozen tasks; the historic corrected R2 Full remains **22/4** and is never overwritten.

Selecting the latest valid official evaluation for each frozen task yields aggregate test evidence of **30/32 F2P (93.75%)** and **592/592 P2P (100%)**. This is a provenance-labelled composite across the R3 Full, Controller-identity recovery, semantic remediation, R9 follow-up, R12 single-task recovery, and carried immutable-js evidence; it is not a newly rerun homogeneous 26-task batch. No Pi rerun and no R2 ablation starts as part of these follow-ups.

`packages/repofixlab/configs/experiments/r2-v6.yaml` freezes 26 existing tasks × Full/No-localize/No-verification-feedback = 78 logical runs, one attempt each, DeepSeek V4 Flash, max 128 model turns, 100 tool calls, 30 minutes, 5M admission tokens per run, and 390M total admission capacity.

The `100 tool calls` statement above describes the retired v6 gate. The active R2 execution contract sets manifest `max_tool_calls` to `null`: tool calls are recorded for trajectory analysis but are not an admission boundary. Token, model-turn, provider-request timeout, and wall-time ceilings remain enforced.

The direct Full execution is complete: 19 of 25 directly executed tasks have official resolved results, three have official unresolved results, and three are classified as Controller identity infrastructure failures pending the dedicated recovery cohort above. `REPOFIX_R2_PHASE=no-localize` and `REPOFIX_R2_PHASE=no-verify-feedback` are explicit later RepoFix-only phases; they must not start before approval.

The Full release claim is permitted only if all are true:

- the historic Test-17 slice reaches at least `13/17`, with no new P2P regression against Pi's historic pass set;
- every controlled-verification outcome retains P0/V1/V2/P1, its baseline/patched comparison, and proceeds to official evaluation unless the Controller itself is unavailable;
- the three historical `karma`-path failures retain final snapshot and evaluator evidence;
- all existing policy/escape fixtures remain rejected with zero unblocked escape;
- token and wall-time comparisons are reported only when complete historical Pi resource evidence exists, otherwise marked `unavailable`.

Localization and feedback value are reported directionally from paired Full-vs-ablation outcomes, McNemar statistics, bootstrap intervals, and adoption/P0→P1 evidence. R2 must not claim that either component is proven useful unless its observed data supports that statement.
