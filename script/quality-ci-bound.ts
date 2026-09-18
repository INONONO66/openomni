import type { Prepared, Counters, Coverage } from "./quality-metrics/coverage";
import { InventoryError } from "./quality-inventory";

/** Exact collector counters are evidence from a completed native receipt. */
export function statementCounters(prepared: Prepared, coverage?: Coverage): Counters {
	const counters = coverage?.totals.get(prepared.path);
	if (!counters)
		throw new InventoryError("measurement", prepared.path, `missing exact statement evidence: ${prepared.path}`);
	return counters;
}
