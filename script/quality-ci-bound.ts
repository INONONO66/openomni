import type { Prepared, Counters, Coverage } from "./quality-metrics/coverage";
import { InventoryError } from "./quality-inventory";

/** Exact collector counters are evidence from a completed native receipt. */
export function statementCounters(prepared: Prepared, coverage?: Coverage): Counters {
	const counters = coverage?.totals.get(prepared.path);
	if (!counters)
		throw new InventoryError("measurement", prepared.path, `missing exact statement evidence: ${prepared.path}`);
	return counters;
}

function entireLine(range: import("istanbul-lib-coverage").Range, lines: string[]): boolean {
	const line = lines[range.start.line - 1] ?? "";
	return line.slice(0, range.start.column).trim() === "" &&
		line.slice(range.end.column).trim().replace(/^;$/, "") === "";
}

function fullyExecuted(
	range: import("istanbul-lib-coverage").Range,
	lines: string[],
	executed: ReadonlyMap<number, number>,
): boolean {
	if (range.start.line > range.end.line || range.end.line > lines.length) return false;
	for (let line = range.start.line; line <= range.end.line; line++)
		if ((executed.get(line) ?? 0) <= 0) return false;
	return range.start.line !== range.end.line || entireLine(range, lines);
}

/** These are proof bits, not inferred statement hits. */
export function conservativeCounters(
	prepared: Prepared, source: string, executed: ReadonlyMap<number, number>,
): Counters {
	const lines = source.split("\n");
	const ranges = Object.entries(prepared.statementMap);
	const s = Object.fromEntries(ranges.map(([id, range]) => {
		const sameStart = ranges.some(([otherId, other]) =>
			otherId !== id && other.start.line === range.start.line);
		return [id, Number(!sameStart && fullyExecuted(range, lines, executed))];
	}));
	const f = Object.fromEntries(Object.keys(prepared.fnMap).map((id) => [id, 0]));
	return { s, f };
}
