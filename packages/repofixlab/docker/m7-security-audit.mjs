import { publishM7SecurityAuditReport } from "../dist/m7/security-audit.js";

const published = await publishM7SecurityAuditReport("/artifacts");
process.stdout.write(
	`${JSON.stringify({
		schema_version: "v1",
		status: published.report.status,
		report_path: published.path,
		report_sha256: published.report.report_sha256,
		audited_run_count: published.report.audited_run_count,
		security: published.report.security,
		unblocked_sandbox_escape_attempt_count: published.report.unblocked_sandbox_escape_attempt_count,
	})}\n`,
);
