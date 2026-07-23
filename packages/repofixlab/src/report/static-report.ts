import type { RunManifest, RunResult } from "../contracts/run-contracts.ts";
import type { StoredArtifact } from "../storage/artifact-store.ts";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function codeRow(label: string, value: string, className = ""): string {
	const classAttribute = className.length === 0 ? "" : ` class="${className}"`;
	return `<tr><th scope="row">${escapeHtml(label)}</th><td><code${classAttribute}>${escapeHtml(value)}</code></td></tr>`;
}

function summaryCard(label: string, value: string, detail: string): string {
	return `<article class="summary-card"><p class="summary-label">${escapeHtml(label)}</p><p class="summary-value">${escapeHtml(value)}</p><p class="summary-detail">${escapeHtml(detail)}</p></article>`;
}

function formatInteger(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatAdmissionCap(value: number | null): string {
	return value === null ? "not enforced (unbounded functional validation)" : formatInteger(value);
}

function formatToolCallCap(value: number | null): string {
	return value === null ? "not enforced (observational only)" : formatInteger(value);
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1_000) return `${formatInteger(milliseconds)} ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
	return `${Math.floor(milliseconds / 60_000)}m ${((milliseconds % 60_000) / 1_000).toFixed(1)}s`;
}

function artifactRow(artifact: StoredArtifact): string {
	return `<tr><td><code class="path">${escapeHtml(artifact.path)}</code></td><td class="numeric">${escapeHtml(formatInteger(artifact.bytes))}</td><td><code class="hash">${escapeHtml(artifact.sha256)}</code></td><td>${escapeHtml(artifact.sensitivity)}</td><td>${escapeHtml(artifact.generatedBy)}</td></tr>`;
}

export function createStaticRunReport(
	manifest: RunManifest,
	terminal: Pick<RunResult, "terminal_status" | "termination_reason" | "resolved" | "wall_time_ms" | "usage">,
	artifacts: readonly StoredArtifact[],
): string {
	const statusTone = terminal.resolved
		? "resolved"
		: terminal.terminal_status === "completed"
			? "unresolved"
			: "failed";
	const resolution = terminal.resolved ? "RESOLVED" : "NOT RESOLVED";
	const estimatedCostCny =
		terminal.usage.estimated_cost_cny_nano === null
			? "Unavailable"
			: `¥${(terminal.usage.estimated_cost_cny_nano / 1_000_000_000).toFixed(9)}`;
	const artifactRows = artifacts.map(artifactRow).join("");
	const scopeBoundary =
		manifest.budget.accounted_admission_cap_tokens === null
			? "This run is an unbounded functional validation: the Token admission cap is intentionally disabled to verify the complete Agent-to-official-evaluation path. It is not evidence for a fair budget comparison."
			: "This report covers one frozen Axios task and one run. It is smoke-test evidence, not a claim of cross-task generalization, statistical significance, or cross-date prompt fairness.";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>RepoFixLab · ${escapeHtml(manifest.run_id)}</title>
<style>
:root{--ink:#182230;--muted:#526273;--line:#d8e0e8;--panel:#fff;--canvas:#f4f7fa;--accent:#2457d6;--accent-soft:#eaf0ff;--ok:#176b43;--ok-soft:#e7f6ee;--warn:#8a4b08;--warn-soft:#fff3d6;--danger:#a12a2a;--danger-soft:#fdeaea;--radius:14px;--shadow:0 10px 30px rgba(24,34,48,.08);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--canvas)}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);line-height:1.5}.skip-link{position:absolute;left:-9999px;top:0}.skip-link:focus{left:1rem;top:1rem;z-index:10;padding:.65rem .9rem;background:#fff;color:var(--accent);border:2px solid var(--accent);border-radius:8px}.page{width:min(1180px,calc(100% - 2rem));margin:0 auto;padding:2rem 0 4rem}.hero{padding:2rem;color:#fff;background:linear-gradient(135deg,#182b50,#2457d6);border-radius:var(--radius);box-shadow:var(--shadow)}.eyebrow{margin:0 0 .4rem;font-size:.78rem;font-weight:750;letter-spacing:.12em;text-transform:uppercase;opacity:.78}.hero h1{margin:0;font-size:clamp(1.8rem,5vw,3rem);line-height:1.15}.run-id{margin:.8rem 0 0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;opacity:.88}.status-line{display:flex;flex-wrap:wrap;align-items:center;gap:.65rem;margin-top:1.25rem}.badge{display:inline-flex;align-items:center;gap:.45rem;padding:.38rem .72rem;border-radius:999px;font-size:.82rem;font-weight:800;letter-spacing:.03em}.badge::before{content:"";width:.55rem;height:.55rem;border-radius:50%;background:currentColor}.badge.resolved{color:#d8ffeb;background:rgba(16,100,61,.55)}.badge.unresolved{color:#fff1c9;background:rgba(116,67,9,.65)}.badge.failed{color:#ffe1e1;background:rgba(126,24,24,.65)}.reason{font-size:.9rem;opacity:.88}.boundary{margin:1.25rem 0;padding:1rem 1.1rem;border:1px solid #e5b95c;border-left:5px solid #c47a13;border-radius:10px;background:var(--warn-soft);color:#5d3a0c}.boundary strong{display:block;margin-bottom:.2rem;color:#713f05}.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:1rem;margin:1.25rem 0}.summary-card{min-width:0;padding:1rem 1.1rem;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}.summary-card p{margin:0}.summary-label{font-size:.76rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.summary-value{margin-top:.38rem!important;font-size:1.4rem;font-weight:800;overflow-wrap:anywhere}.summary-detail{margin-top:.25rem!important;font-size:.78rem;color:var(--muted)}.panel{margin-top:1.25rem;padding:1.35rem;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}.panel h2{margin:0;font-size:1.15rem}.panel-intro{margin:.3rem 0 1rem;color:var(--muted);font-size:.9rem}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;background:#fff;font-size:.88rem}caption{padding:.75rem 1rem;text-align:left;font-weight:700;color:var(--muted);background:#f8fafc;border-bottom:1px solid var(--line)}th,td{padding:.72rem .85rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}thead th{font-size:.74rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:#f8fafc}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}tbody th{width:30%;font-weight:700;color:#354557;background:#fbfcfd}.numeric{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.8rem}.hash{display:block;min-width:34ch;overflow-wrap:anywhere;word-break:break-all;user-select:all}.path{overflow-wrap:anywhere;word-break:break-word;user-select:all}.artifact-count{display:inline-block;margin-left:.35rem;padding:.12rem .48rem;border-radius:999px;color:var(--accent);background:var(--accent-soft);font-size:.72rem;vertical-align:.12rem}.footer{margin-top:1.4rem;text-align:center;color:var(--muted);font-size:.78rem}
@media (max-width:640px){.page{width:min(100% - 1rem,1180px);padding-top:.5rem}.hero{padding:1.35rem}.panel{padding:1rem}.summary-grid{grid-template-columns:1fr 1fr;gap:.65rem}.summary-card{padding:.85rem}.summary-value{font-size:1.1rem}th,td{padding:.62rem}.hash{min-width:28ch}}
@media print{:root,body{background:#fff}.skip-link{display:none}.page{width:100%;padding:0}.hero{color:#000;background:#fff;border:2px solid #000;box-shadow:none}.badge{color:#000!important;background:#fff!important;border:1px solid #000}.boundary,.summary-card,.panel{box-shadow:none;background:#fff;border-color:#777}.panel,.summary-card,.boundary,tr{break-inside:avoid}.table-wrap{overflow:visible}.hash{min-width:0}.footer{color:#000}}
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to report content</a>
<div class="page">
<header class="hero" aria-labelledby="report-title">
<p class="eyebrow">Immutable evaluation evidence</p>
<h1 id="report-title">RepoFixLab Run Report</h1>
<p class="run-id">${escapeHtml(manifest.run_id)}</p>
<div class="status-line"><span class="badge ${statusTone}">${escapeHtml(resolution)}</span><span class="reason">${escapeHtml(terminal.terminal_status)} · ${escapeHtml(terminal.termination_reason)}</span></div>
</header>
<aside class="boundary" aria-label="M1 evaluation scope boundary"><strong>M1 single-task boundary</strong>${escapeHtml(scopeBoundary)}</aside>
<main id="main-content">
<section class="summary-grid" aria-label="Run summary">
${summaryCard("Resolution", terminal.resolved ? "Yes" : "No", terminal.termination_reason)}
${summaryCard("Status", terminal.terminal_status, "Terminal lifecycle state")}
${summaryCard("Wall time", formatDuration(terminal.wall_time_ms), `${formatInteger(terminal.wall_time_ms)} ms exact`)}
${summaryCard("Accounted tokens", formatInteger(terminal.usage.accounted_tokens), terminal.usage.usage_complete ? "Usage complete" : "Usage incomplete")}
${summaryCard("Estimated cost", estimatedCostCny, terminal.usage.cost_complete ? "Frozen CNY pricing snapshot" : "Cost incomplete")}
</section>
<section class="panel" aria-labelledby="bindings-title"><h2 id="bindings-title">Run bindings</h2><p class="panel-intro">Immutable identities required to reproduce and audit this run.</p><div class="table-wrap"><table><caption>Manifest, task, model, pricing, prompt, and tool bindings</caption><tbody>${codeRow("experiment_id", manifest.experiment_id)}${codeRow("instance_id", manifest.instance_id)}${codeRow("config_id", manifest.config_id)}${codeRow("manifest_sha256", manifest.manifest_sha256, "hash")}${codeRow("task_environment_lock_sha256", manifest.task_environment_lock_sha256, "hash")}${codeRow("model_spec_sha256", manifest.model.model_spec_sha256, "hash")}${codeRow("pricing_spec_sha256", manifest.model.pricing_spec_sha256, "hash")}${codeRow("pricing_source", "https://bigmodel.cn/pricing")}${codeRow("system_prompt_sha256", manifest.model.system_prompt_sha256, "hash")}${codeRow("tool_schema_sha256", manifest.model.tool_schema_sha256, "hash")}</tbody></table></div></section>
<section class="panel" aria-labelledby="budget-title"><h2 id="budget-title">Budget and measured usage</h2><p class="panel-intro">Admission ceilings are shown beside observed usage and the exact integer cost estimate.</p><div class="table-wrap"><table><caption>Frozen budget and observed consumption</caption><tbody>${codeRow("accounted_admission_cap_tokens", formatAdmissionCap(manifest.budget.accounted_admission_cap_tokens))}${codeRow("accounted_tokens", formatInteger(terminal.usage.accounted_tokens))}${codeRow("provider_actual_tokens", terminal.usage.provider_actual_tokens === null ? "unavailable" : formatInteger(terminal.usage.provider_actual_tokens))}${codeRow("max_model_turns", formatInteger(manifest.budget.max_model_turns))}${codeRow("model_turns", formatInteger(terminal.usage.model_turns))}${codeRow("max_tool_calls", formatToolCallCap(manifest.budget.max_tool_calls))}${codeRow("tool_calls", formatInteger(terminal.usage.tool_calls))}${codeRow("max_wall_time_ms", formatInteger(manifest.budget.max_wall_time_ms))}${codeRow("wall_time_ms", formatInteger(terminal.wall_time_ms))}${codeRow("usage_complete", String(terminal.usage.usage_complete))}${codeRow("cost_complete", String(terminal.usage.cost_complete))}${codeRow("estimated_cost_cny", estimatedCostCny)}${codeRow("estimated_cost_cny_nano", terminal.usage.estimated_cost_cny_nano === null ? "unavailable" : formatInteger(terminal.usage.estimated_cost_cny_nano))}</tbody></table></div></section>
<section class="panel" aria-labelledby="artifacts-title"><h2 id="artifacts-title">Artifact inventory <span class="artifact-count">${escapeHtml(formatInteger(artifacts.length))}</span></h2><p class="panel-intro">Every hash is shown in full. Select or copy a hash directly for offline verification.</p><div class="table-wrap"><table><caption>Indexed evidence artifacts</caption><thead><tr><th scope="col">Path</th><th scope="col" class="numeric">Bytes</th><th scope="col">SHA-256</th><th scope="col">Sensitivity</th><th scope="col">Generated by</th></tr></thead><tbody>${artifactRows}</tbody></table></div></section>
</main>
<footer class="footer">Self-contained report · No external resources · No executable JavaScript</footer>
</div>
</body>
</html>
`;
}
