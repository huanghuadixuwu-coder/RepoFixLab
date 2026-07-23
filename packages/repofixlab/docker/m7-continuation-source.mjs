import { finalizeM7ContinuationSource } from "../dist/m7/batch-runner.js";
import { GlobalBudgetLedger } from "../dist/runner/global-budget-ledger.js";

const sourceRoot = "/artifacts/m7-v1.7.2";
const store = await finalizeM7ContinuationSource(sourceRoot);
const counts = Object.fromEntries(
	store.values.reduce((groups, state) => {
		groups.set(state.status, (groups.get(state.status) ?? 0) + 1);
		return groups;
	}, new Map()),
);
const budget = await GlobalBudgetLedger.open(`${sourceRoot}/_control/m7-global-budget.json`, 370_000_000);
process.stdout.write(`${JSON.stringify({ schema_version: "v1", status: "pass", source_run_counts: counts, source_budget_reconciliation_required: budget.snapshot.reconciliation_required })}\n`);
