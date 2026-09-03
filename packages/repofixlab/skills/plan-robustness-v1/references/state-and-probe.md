# State and Verification Alignment

This reference defines how PLAN represents runtime ordering and selects a Controller-provided verification candidate without confusing nearby behavior with the reported defect.

## 1. Construct the transition

For each stateful or callback-driven failure, identify:

```text
pre-state --trigger--> observed bad post-state
pre-state --trigger--> required post-state
```

States must be observable or tied to visible program facts: remaining work, stored state, resource ownership, DOM/output state, propagated error, or re-entry-visible values. Avoid labels such as “state A” unless their conditions are stated.

## 2. Direction is semantic

`ALLOW` describes required or preserved behavior. `FORBID` describes the reported failure or a concrete regression.

Generic traversal example:

```text
ALLOW: first handler throws with later handlers pending --error handling--> later required handlers run before the error leaves the traversal
FORBID: first handler throws with later handlers pending --immediate propagation--> traversal terminates while required handlers remain
```

Do not forbid a recovery transition merely because an error appears at its start. Evaluate the post-state and ordering, not the presence of the exception.

## 3. Required ordering cases

When applicable, cover:

- success: all required work completes in the existing order;
- error: required cleanup or state restoration completes before error propagation;
- re-entry: user code observes state that has already been made internally consistent;
- deferred work: queued or later work is neither lost nor executed twice;
- multiple errors: the plan states the required continuation and final propagation behavior without inventing semantics unsupported by the repository.

If these classes do not apply, state why using repository evidence rather than writing “not applicable” without support.

## 4. Obligations, invariants, and risks

- Obligation: a semantic outcome the repair must produce at a confirmed code scope.
- Preservation invariant: existing behavior that must remain true, with an observable falsifier.
- Risk: residual uncertainty or limitation that may remain after the planned work.

The incorrect transition reported by the issue belongs in an obligation as the behavior to eliminate, and usually in `state_transition_checks` as `FORBID`. It is not an acceptable residual risk.

## 5. Verification candidate alignment

Compare each available Controller candidate with the issue along three axes:

1. trigger: the same event or lifecycle path initiates the behavior;
2. preconditions: the same relevant state and ordering conditions exist;
3. observation: the candidate can observe every critical required outcome.

Choose the closest valid candidate. A test of a neighboring API, an explicit teardown, or a direct helper call does not prove behavior reached through a different trigger path unless repository evidence establishes equivalence.

If no candidate is fully aligned:

- still select exactly one valid Controller-provided ID as required by the PLAN schema;
- record the precise coverage gap in `risks`;
- do not invent a command, candidate, or claim of verification.

## 6. Final direction audit

Read every state check literally:

- Are the pre-state and post-state explicit?
- Does `FORBID` end in the actual defect or regression?
- Does `ALLOW` end in the required behavior?
- Is continuation after an error correctly distinguished from early termination?
- Is error propagation ordered after required cleanup when repository behavior requires that ordering?
