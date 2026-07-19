# RepoFixLab evaluator kernel

This package is the evaluator-only, standard-library Python boundary for Axios
`axios__axios-5892`. It does not create containers and does not claim that the M0
Docker probes have passed.

The adapted path resets `/testbed` to the frozen base, validates the candidate
and hidden test patches, rejects path overlap, applies both patches, and executes
exactly:

```text
npx mocha test/unit/adapters/http.js -R tap -g compression
```

The pristine path is deliberately independent. The Controller must first invoke
the pinned upstream module `swebench.harness.run_evaluation` from commit
`726c5461e2ef52d83cf1ea2107870a8bb3328d57`. The normalizer then verifies every
locked upstream grading/parser source file and calls the pinned upstream
`parse_log_tap`, `get_eval_tests_report`, and `get_resolution_status` functions.
It does not call the adapted parser. This prevents a parser from being declared
equivalent merely by comparing its output with itself.

The upstream repository does not ship a fully resolved Python dependency lock.
The committed source lock therefore binds the complete 591-file `swebench`
source aggregate and upstream `pyproject.toml`, but it is not yet a runtime
dependency lock. Before a real pristine probe can count as M0 evidence, the
pristine Controller image must add a reviewed exact dependency lock and bind its
image ID. Direct reuse of an unpinned ambient `swebench` installation is
forbidden.

Container protocol:

- mount one sealed private task file read-only below
  `/run/repofixlab/private`; only the Evaluator receives this mount;
- mount the candidate read-only below `/run/repofixlab/input`; gold is selected
  inside the Evaluator and is never copied to the candidate mount;
- use a fresh `/testbed`, `network=none`, a read-only root filesystem, and a
  dedicated writable evidence volume;
- write raw logs and the canonical report to unique exclusive paths; stdout is
  only the canonical report, and failures emit one fixed diagnostic;
- never place gold patch or test patch bytes in stdout or a report. Reports bind
  them only by SHA-256.

The Controller must independently record container image ID, security profile,
timeout, exit status, and residual cleanup evidence. Those controls are outside
this pure evaluation kernel.
