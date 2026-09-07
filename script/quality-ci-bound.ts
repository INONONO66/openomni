import type { Prepared, Counters } from "./quality-metrics/coverage";
import type { Range } from "istanbul-lib-coverage";

function entireLine(range: Range, lines: string[]): boolean {
	const line = lines[range.start.line - 1] ?? "";
	return range.start.line === range.end.line &&
		line.slice(0, range.start.column).trim() === "" &&
		line.slice(range.end.column).trim().replace(/^;$/, "") === "";
}

/** d945-lcov-crap-upper-bound@1. These are proof bits, NOT statement hit counts.
 * Ambiguous, multiline, unselected and uninstrumented statements get no credit.
 * Function hit counts cannot be recovered from Bun's aggregate FNH.
 * Calling joinCoverage with these lower bounds gives an upper bound on CRAP. */
export function conservativeCounters(
	prepared: Prepared, source: string, executed: ReadonlyMap<number, number>,
): Counters {
	const lines = source.split("\n");
	const ranges = Object.entries(prepared.statementMap);
	const s = Object.fromEntries(ranges.map(([id, range]) => {
		const overlaps = ranges.filter(([, other]) =>
			other.start.line <= range.start.line && other.end.line >= range.start.line);
		const proven = (executed.get(range.start.line) ?? 0) > 0 &&
			entireLine(range, lines) && overlaps.length === 1;
		return [id, Number(proven)];
	}));
	const f = Object.fromEntries(Object.keys(prepared.fnMap).map((id) => [id, 0]));
	return { s, f };
}
