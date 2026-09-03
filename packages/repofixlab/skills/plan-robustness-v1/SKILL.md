---
name: repofix-plan-robustness-v1
description: Build a minimal, evidence-bound RepoFix PLAN and submit it through the native stage_complete contract. Use only during the RepoFix PLAN stage.
---

# RepoFix PLAN Robustness

Use this skill only while the active RepoFix stage is `PLAN`.

Keep the native Agent contract: investigate with the repository tools currently available, use the existing PLAN schema, and finish with exactly one `stage_complete` tool call. Do not output a bare PLAN JSON object, invent fields, edit code, or perform verification in this stage.

## Required procedure

### 1. Reconstruct the defect contract

Before choosing code sites, write down internally:

- the reported trigger and required preconditions;
- the incorrect observable transition or outcome;
- every observable outcome that the repair must guarantee;
- neighboring behavior that must remain unchanged.

An outcome explicitly required by the issue is a required behavior. Never downgrade it to a risk merely because the current implementation already fails that way.

### 2. Bind every claim to direct evidence

For each candidate or planned code site, confirm the visible evidence binds all three elements:

```text
path + symbol/code region + actual behavior relevant to the defect
```

An evidence identifier, filename, or prior-stage assertion alone is not proof. If the visible body does not support the claim, inspect the exact region with `repo_read` or `repo_search`. If direct evidence still cannot be obtained, do not present the site as confirmed.

See [evidence-and-scope.md](references/evidence-and-scope.md) for the sufficiency and scope rules.

### 3. Reduce candidates to causal roles

Classify every relevant LOCALIZE candidate:

- `must_change`: direct evidence shows this site causes the forbidden behavior, and the required outcome cannot be achieved without changing it;
- `read_only_dependency`: the site explains control flow or constrains the repair but does not itself require modification;
- `excluded`: evidence shows the site is analogous, downstream, already correct, or unrelated.

LOCALIZE candidates are investigation leads, not automatic PLAN obligations. Investigate uncertainty; do not turn uncertainty into a broad change step.

### 4. Build the smallest complete plan

Create `minimal_change_steps` only for `must_change` sites. Use one step per distinct code site and semantic change. Merge duplicate descriptions of the same edit; do not split one edit into repeated callback, caller, and consequence steps.

Create stable `obligations` for the semantic outcomes that IMPLEMENT and SELF_REVIEW must disposition. Each obligation must:

- name a concrete `code_scope` supported by direct repository evidence;
- state the required observable semantic outcome, not a proposed code snippet;
- cite evidence that supports both the scope and the reason for change.

Do not add an obligation merely to mirror every candidate. If an outcome spans multiple sites, include only sites for which a modification is causally necessary.

### 5. Preserve neighboring behavior

Add `preservation_invariants` for affected normal, error, and neighboring branches. Each invariant must contain:

- the affected scope;
- behavior that must remain true;
- a concrete observable counterexample that would falsify it;
- supporting repository evidence.

Put only residual uncertainty or implementation hazards in `risks`. A reported failure, required outcome, or known regression that the repair must prevent belongs in an obligation or preservation invariant, not in `risks`.

### 6. Check state-transition direction

For callbacks, cleanup traversal, deferred state, or re-entry, reason through success, error, and re-entry ordering. Express each `state_transition_checks` item as one explicit assertion:

```text
ALLOW: <pre-state> --<trigger>--> <required post-state>; evidence: <why>
FORBID: <pre-state> --<trigger>--> <incorrect post-state>; evidence: <why>
```

The forbidden transition must describe the defect, not the required recovery path. When one callback fails but later required work must continue, continuation is `ALLOW`; early termination is `FORBID`.

See [state-and-probe.md](references/state-and-probe.md) for ordering and verification alignment.

### 7. Select an aligned verification candidate

Choose exactly one Controller-provided `verification_candidate_id`. Never invent a command or candidate ID. Prefer the available candidate whose trigger, preconditions, and observable result are closest to the issue. If no candidate exercises the critical transition, choose the best available valid ID and record the coverage gap as a risk; do not claim the candidate proves the repair.

### 8. Audit and submit once

Before completion, verify all of the following:

- every issue-required outcome appears in an obligation or preservation invariant;
- no issue-required outcome is accepted only as a risk;
- every change step and obligation has direct path, region, and behavior evidence;
- every LOCALIZE candidate has been reduced to a causal role;
- no two steps describe the same code site and semantic change;
- allowed and forbidden transition directions are correct;
- the verification candidate is Controller-provided and its limitations are honest;
- the payload uses only the current RepoFix PLAN fields.

Then call `stage_complete` exactly once, as the sole tool call in the assistant message.

Review [bad-case-patterns.md](references/bad-case-patterns.md) only as a final anti-pattern checklist.
