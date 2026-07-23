import { publishM9Analysis } from "../dist/m9/analysis.js";

const published = await publishM9Analysis("/artifacts");
process.stdout.write(`${JSON.stringify({ schema_version: "v1", status: published.report.status, report_sha256: published.report.report_sha256, json_path: published.json_path, markdown_path: published.markdown_path, html_path: published.html_path, first_attempt: published.report.first_attempt, operational_final: published.report.operational_final, resources: published.report.resources })}\n`);
