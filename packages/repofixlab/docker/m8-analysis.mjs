import { publishM8Analysis } from "../dist/m8/analysis.js";

const continuationReportPath = process.env.REPOFIX_M8_CONTINUATION_REPORT;
const securityAuditReportPath = process.env.REPOFIX_M8_SECURITY_AUDIT;
if (typeof continuationReportPath !== "string" || continuationReportPath.length === 0 || typeof securityAuditReportPath !== "string" || securityAuditReportPath.length === 0) {
	throw new Error("M8 requires REPOFIX_M8_CONTINUATION_REPORT and REPOFIX_M8_SECURITY_AUDIT artifact-relative paths");
}

const published = await publishM8Analysis("/artifacts", {
	continuation_report_path: continuationReportPath,
	security_audit_report_path: securityAuditReportPath,
});
process.stdout.write(`${JSON.stringify({
	schema_version: "v1",
	status: published.report.status,
	report_sha256: published.report.report_sha256,
	json_path: published.json_path,
	markdown_path: published.markdown_path,
	html_path: published.html_path,
	population: published.report.population,
})}\n`);
