import { posix } from "node:path";
import { requireMeasurement } from "./quality-ci-receipt";

export type NativeLines = { path: string; lines: { line: number; hits: number }[] };

function count(value: string): number {
	requireMeasurement(/^\d+$/.test(value), "invalid LCOV count");
	const result = Number(value);
	requireMeasurement(Number.isSafeInteger(result), "LCOV count overflow");
	return result;
}
function lineCounter(value: string) {
	const fields = value.split(",");
	const line = count(fields[0] ?? ""), hits = count(fields[1] ?? "");
	requireMeasurement(line > 0 && fields.length === 2, "invalid LCOV DA");
	return { line, hits };
}
function sourceRecord(block: string, lane: string): NativeLines {
	const lines = block.trim().split("\n");
	const source = lines.filter((line) => line.startsWith("SF:"));
	requireMeasurement(source.length === 1, "missing or duplicate LCOV source");
	const path = posix.normalize(posix.join(lane, source[0]?.slice(3) ?? ""));
	requireMeasurement(!path.startsWith("../") && !posix.isAbsolute(path), "LCOV source escapes root");
	const counters = lines.filter((line) => line.startsWith("DA:")).map((line) => lineCounter(line.slice(3)));
	requireMeasurement(new Set(counters.map((row) => row.line)).size === counters.length, "duplicate LCOV line");
	const found = lines.filter((line) => line.startsWith("LF:"));
	const hit = lines.filter((line) => line.startsWith("LH:"));
	requireMeasurement(found.length === 1 && hit.length === 1, "missing or duplicate LCOV totals");
	requireMeasurement(count(found[0]?.slice(3) ?? "") === counters.length, "LCOV LF differs from DA");
	requireMeasurement(count(hit[0]?.slice(3) ?? "") === counters.filter((row) => row.hits > 0).length, "LCOV LH differs from DA");
	return { path, lines: counters };
}
export function parseNativeLcov(text: string, lane: string): NativeLines[] {
	const blocks = text.trim().split("end_of_record");
	requireMeasurement(blocks.pop()?.trim() === "", "unterminated LCOV report");
	const records = blocks.map((block) => sourceRecord(block, lane));
	requireMeasurement(records.length > 0, "empty LCOV report");
	requireMeasurement(new Set(records.map((row) => row.path)).size === records.length, "duplicate LCOV file");
	return records;
}
