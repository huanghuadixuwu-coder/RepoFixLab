# RepoFixLab M9 reuse-first completion protocol

## Purpose

M9 completes the frozen 26-task SWE-bench JS/TS main comparison without
repeating M7 observations that already have valid official-evaluator evidence.
M7 remains immutable. M9 records only new logical runs and joins them with the
M7 continuation report during final analysis.

## Frozen task-level policy

Each task has one `pi-general` and one `repofix-full` outcome.

- A M7 main observation with a verified official result is reused, retaining
  its actual 64- or 128-turn ceiling.
- A verified result at 64 turns is evidence that the task completed within the
  M9 `<=128` ceiling. It must never be relabelled as an observed 128-turn run.
- A `continuation_failed` observation remains a first-attempt terminal failure.
  M9 may add one separately identified controlled recovery; it never overwrites
  the M7 record.
- A task/configuration with no M7 main observation receives one new first
  attempt at 128 turns.

## New-run matrix

| Group | Tasks | Configurations | New runs |
| --- | ---: | --- | ---: |
| `m9-new-main-pairs` | 9 | Pi-general, RepoFix-full | 18 |
| `m9-repofix-controlled-recovery` | 3 | RepoFix-full | 3 |
| Total | 12 distinct tasks | — | 21 |

The nine new-pair tasks are `axios-4738`, `axios-5892`, `three.js-26589`,
and Preact `2927`, `3010`, `3062`, `3562`, `4182`, `4245`. The three recovery
tasks are Preact `2757`, `2896`, and `3739`.

## Metrics

M9 publishes both metrics; neither replaces the other.

1. **First-attempt task outcome**: uses all existing M7 first terminal
   observations plus the M9 first attempts. A no-final-snapshot remains a
   first-attempt failure.
2. **Operational final outcome**: applies at most one controlled recovery only
   to a no-final-snapshot case, preserving the prior attempt and all cumulative
   Token/time evidence.

The primary paired outcome is task-level resolution under an actual turn ceiling
of at most 128. Analyses must show the observed 64/128 ceiling for every pair
and must not make a fixed-128 claim from 64-turn observations.

## Fairness and safety

- Both Pi and RepoFix are eligible for the same single controlled-recovery rule;
  M9 does not retry successful or officially evaluated unsuccessful results.
- Each new run has a 5,000,000 Token admission reservation, one fresh Docker
  Worker, and one fresh official Evaluator.
- The 21-run M9 ledger is independent of the M7 ledger; its total admission cap
  is 105,000,000 Token.
- Failed M9 runs are terminal. They are never silently retried or substituted.
