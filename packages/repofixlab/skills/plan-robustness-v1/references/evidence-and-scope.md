# Evidence and Scope Rules

This reference defines how PLAN converts prior candidates and current repository observations into a minimal set of change sites.

## 1. Direct evidence tuple

A PLAN claim is directly supported only when visible repository evidence establishes:

```text
path + symbol/code region + behavior relevant to the claim
```

The behavior component must come from code or a repository-owned test/configuration that is actually visible. A matching evidence ID, filename, symbol name, candidate description, or model summary is insufficient by itself.

If a prior artifact cites evidence whose body belongs to another path or region, treat the claim as unverified and inspect the intended region. Never repair an evidence mismatch by reusing the convenient ID.

## 2. Evidence sufficiency by claim

| Claim | Minimum evidence |
|---|---|
| A site directly causes the failure | The relevant branch, call, state write, or traversal behavior is visible |
| A caller must also change | The caller's visible control flow prevents the required outcome even after the callee is corrected |
| A site is read-only | Its behavior constrains the repair, but the required outcome remains possible without modifying it |
| A site is excluded | Visible flow shows it is analogous, downstream-only, already correct, or outside the trigger path |
| A behavior must be preserved | The affected neighboring branch and its observable behavior are visible |

Repository evidence may support more than one claim only when its actual body supports each claim. Evidence identity is not evidence semantics.

## 3. Causal classification

For each candidate, ask in order:

1. Does direct evidence place this site on the reported trigger path?
2. Does this site create or enforce the incorrect transition?
3. If all other sites stayed unchanged, could changing this site satisfy the required outcome?
4. If this site stayed unchanged, could the required outcome still be satisfied by a narrower change elsewhere?

Classify the site as:

- `must_change` when it is on the trigger path and leaving it unchanged prevents the required outcome;
- `read_only_dependency` when it explains the path or supplies a preservation constraint but need not change;
- `excluded` when direct evidence removes it from the necessary repair scope.

If the answers remain unknown, obtain narrower evidence. Do not classify “unknown” as `must_change` merely to be safe.

## 4. Minimality and completeness

Minimal does not mean the fewest filenames at any cost. It means no planned edit can be removed without losing a required outcome or preservation guarantee.

Complete does not mean modifying every related function. It means every issue-required observable outcome is covered by a causally necessary edit or a verified preservation constraint.

Use these mechanical rules:

- one distinct code site and semantic change → one change step;
- two descriptions with the same path, region, and outcome → merge;
- caller and callee both change → retain both only when direct evidence proves independent required behavior at each site;
- analogous implementation → read or exclude unless the reported trigger reaches it;
- downstream consequence → express as an obligation outcome, not automatically as another edit site;
- speculative hardening beyond the issue contract → exclude from the repair plan.

## 5. Evidence-bound PLAN fields

`minimal_change_steps` describe what must change and where, without prescribing an exact patch.

`obligations[].evidence` must justify both `code_scope` and `required_change`. If one evidence passage cannot support both, obtain additional evidence or narrow the obligation.

`preservation_invariants[].evidence` must show the neighboring behavior exists and could be affected by the planned scope.

`risks` may state an unresolved limitation, uncertainty, or verification gap. Risks must not be used to excuse an explicit acceptance requirement.

## 6. Final scope audit

For every change step, point to at least one obligation it enables. For every obligation, point to a must-change site or state why it is a cross-site outcome. Remove any step that has no unique causal responsibility.
