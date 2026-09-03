# PLAN Bad-Case Patterns

Use this reference only as a final review checklist. The examples are abstract and do not prescribe a repository-specific answer.

| Anti-pattern | Why it fails | Required correction |
|---|---|---|
| Promote every LOCALIZE candidate to a change step | LOCALIZE contains investigation leads and analogous sites, not confirmed edits | Classify each candidate as `must_change`, `read_only_dependency`, or `excluded` using direct causality evidence |
| Accept an evidence ID without checking its body | The ID may resolve to the wrong path, region, or behavior | Verify path, code region, and actual behavior together; inspect missing evidence |
| Put the reported failure in `risks` | The plan permits the defect to survive while appearing cautious | Convert required behavior into an obligation and the bad transition into `FORBID` |
| Forbid continuation after an error when continuation is required | The transition direction is reversed | Forbid early termination; allow required continuation followed by the intended error handling |
| Use a nearby test as if it reproduced the issue | Similar APIs can enter different lifecycle and state paths | Compare trigger, preconditions, and observable results; disclose any candidate coverage gap |
| Add callers, callees, and downstream effects as separate edits without proof | Scope expands from consequences rather than causal necessity | Keep a site only when leaving it unchanged blocks a required outcome |
| Repeat the same path and semantic change in multiple steps | Long plans obscure responsibility and increase inconsistent edits | Merge by path, region, and semantic outcome |
| Prescribe exact replacement code in PLAN | PLAN becomes a speculative patch before implementation evidence is reconciled | State required semantics and scope; leave exact editing to IMPLEMENT |
| Emit a bare JSON plan | RepoFix cannot complete the stage without its native tool contract | Call `stage_complete` exactly once as the sole final tool call |
| Add richer fields not present in the PLAN schema | Structurally plausible output is rejected by the FSM | Encode requirements in existing obligations, invariants, risks, state checks, and verification candidate ID |

Final rejection rule: if direct evidence is missing, transition direction is ambiguous, or the selected verification candidate is not equivalent, investigate or disclose the precise limitation. Never hide uncertainty by expanding the change scope.
