import type { Prepared, Counters } from "./quality-metrics/coverage";
import type { Range } from "istanbul-lib-coverage";

function entireLine(range: Range, lines: string[]): boolean {
	const line = lines[range.start.line - 1] ?? "";
	return line.slice(0, range.start.column).trim() === "" &&
		line.slice(range.end.column).trim().replace(/^;$/, "") === "";
}

function fullyExecuted(range: Range, lines: string[], executed: ReadonlyMap<number, number>): boolean {
	if (range.start.line > range.end.line || range.end.line > lines.length) return false;
	for (let line = range.start.line; line <= range.end.line; line++)
		if ((executed.get(line) ?? 0) <= 0) return false;
	return range.start.line !== range.end.line || entireLine(range, lines);
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
		// Line evidence cannot distinguish two statements beginning on the same
		// line. Ranges nested across distinct start lines are independently
		// proven when every line they span executed.
		const sameStart = ranges.some(([otherId, other]) =>
			otherId !== id && other.start.line === range.start.line);
		const proven = !sameStart && fullyExecuted(range, lines, executed);
		return [id, Number(proven)];
	}));
	const f = Object.fromEntries(Object.keys(prepared.fnMap).map((id) => [id, 0]));
	return { s, f };
}
