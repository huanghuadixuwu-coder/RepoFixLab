import { publishM7ContinuationReport } from "../dist/m7/continuation-report.js";

const published = await publishM7ContinuationReport("/artifacts");
process.stdout.write(
	`${JSON.stringify({
		schema_version: "v1",
		status: published.report.status,
		report_path: published.path,
		report_sha256: published.report.report_sha256,
		terminal_observation_count: published.report.terminal_observation_count,
		comparison_scope: published.report.comparison_scope,
	})}\n`,
);
