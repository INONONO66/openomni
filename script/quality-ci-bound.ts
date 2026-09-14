import type { Prepared, Counters, Coverage } from "./quality-metrics/coverage";
import { InventoryError } from "./quality-inventory";

/** Native LCOV projects basic-block bytes onto lines; even a unique whole-line
 * range can have positive DA without executing. Missing exact evidence is an
 * unresolved measurement, never fabricated zero counters or statement credit.
 * The existing collector/loadCoverage owns source maps and process aggregation. */
export function statementCounters(prepared: Prepared, coverage?: Coverage): Counters {
	const counters = coverage?.totals.get(prepared.path);
	if (!counters) throw new InventoryError("measurement", prepared.path, `missing exact statement evidence: ${prepared.path}`);
	return counters;
}
