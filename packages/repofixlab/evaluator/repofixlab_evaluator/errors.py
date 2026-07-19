from __future__ import annotations


class EvaluationError(Exception):
    """Base class for evaluator failures whose text must never enter reports."""

    error_class = "internal_error"


class PrivateSpecError(EvaluationError):
    error_class = "internal_error"


class BaseStateError(EvaluationError):
    error_class = "base_state_error"


class PatchPolicyError(EvaluationError):
    error_class = "patch_policy_error"


class PatchApplyError(EvaluationError):
    error_class = "patch_apply_error"


class TestPatchPolicyError(EvaluationError):
    error_class = "test_patch_policy_error"


class TestPatchConflictError(EvaluationError):
    error_class = "test_patch_conflict"


class TestPatchApplyError(EvaluationError):
    error_class = "test_patch_apply_error"


class TapParseError(EvaluationError):
    error_class = "test_execution_error"


class OfficialSourceError(EvaluationError):
    error_class = "official_source_error"


class OfficialReportError(EvaluationError):
    error_class = "official_report_error"
