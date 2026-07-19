"""Generation-scoped SWE-bench dataset materialization."""

from .constants import DATASET_NAME, DATASET_REVISION, EXPECTED_RECORD_COUNT
from .errors import PreparationError
from .prepare import PreparationRequest, prepare_generation, verify_generation

__all__ = [
    "DATASET_NAME",
    "DATASET_REVISION",
    "EXPECTED_RECORD_COUNT",
    "PreparationError",
    "PreparationRequest",
    "prepare_generation",
    "verify_generation",
]
