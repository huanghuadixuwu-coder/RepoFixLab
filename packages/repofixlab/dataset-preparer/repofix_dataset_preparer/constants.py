"""Frozen dataset protocol constants."""

DATASET_NAME = "SWE-bench/SWE-bench_Multilingual"
DATASET_REVISION = "2b7aced941b4873e9cad3e76abbae93f481d1beb"
DATASET_SOURCE_PATH = "data/test-00000-of-00001.parquet"
DATASET_SOURCE_BYTES = 1_165_968
DATASET_SOURCE_SHA256 = "28b7f874e48496399077d276f9f2b163a077ddf0a70dc507c148d58da826baa9"
EXPECTED_SOURCE_RECORD_COUNT = 300
EXPECTED_RECORD_COUNT = 43
REQUIRED_INSTANCE_ID = "axios__axios-5892"
SCHEMA_VERSION = "v1"
DIFF_PARSER_VERSION = "unified-diff-v1"
MAX_SOURCE_BYTES = 512 * 1024 * 1024

EXPECTED_REPO_COUNTS = {
    "babel/babel": 5,
    "vuejs/core": 5,
    "facebook/docusaurus": 5,
    "immutable-js/immutable-js": 2,
    "mrdoob/three.js": 3,
    "preactjs/preact": 17,
    "axios/axios": 6,
}
JAVASCRIPT_TYPESCRIPT_REPOS = frozenset(EXPECTED_REPO_COUNTS)

PRIVATE_FIELD_NAMES = frozenset(
    {
        "patch",
        "gold_patch",
        "test_patch",
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "fail_to_pass",
        "pass_to_pass",
        "harness_parameters",
        "sampling_metadata",
        "issue_bytes",
        "gold_changed_lines",
    }
)
