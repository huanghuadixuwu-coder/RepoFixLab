# Frozen official harness source

`official-swebench-v4.1.0.json` binds the exact upstream source path that provides
the pristine Axios oracle: the `run_evaluation` entry point, JavaScript TAP
parser, grading implementation, JavaScript test-spec builder, and frozen Axios
command constants at commit `726c5461e2ef52d83cf1ea2107870a8bb3328d57`.

The lock is not a claim that a pristine container ran. A valid M0 artifact must
also include the official raw report/log, the source verifier result, the
adapted report/log, and the four-probe equivalence report.

The upstream dependency declaration is hashed, but upstream does not provide a
fully resolved Python lock. A reviewed exact dependency lock and the resulting
pristine image ID remain mandatory runtime evidence; this source lock alone
cannot publish an M0 pass.
