import { expect, test } from "bun:test";
import { statementCounters } from "./quality-ci-bound";
import type { Prepared } from "./quality-metrics/coverage";

const range = (start: number, end = start): import("istanbul-lib-coverage").Range => ({
	start: { line: start, column: 0 }, end: { line: end, column: 10 },
});
const prepared: Prepared = {
	path: "script/a.ts", sha256: "a".repeat(64), mapHash: "b".repeat(64), code: "",
	statementMap: { a: range(1), b: range(2), c: range(2), d: range(3, 4) },
	fnMap: {},
};

test("missing exact counters fail closed instead of inferring hits or fabricating zeros", () => {
	expect(() => statementCounters(prepared)).toThrow("missing exact statement evidence");
	expect(() => statementCounters(prepared, { run: { id: "missing", head: "", tree: "" }, totals: new Map(), processes: [], receiptHash: "" })).toThrow("missing exact statement evidence");
});
