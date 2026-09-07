import { expect, test } from "bun:test";
import { conservativeCounters } from "./quality-ci-bound";
import type { Prepared } from "./quality-metrics/coverage";

const range = (start: number, end = start): import("istanbul-lib-coverage").Range => ({
	start: { line: start, column: 0 }, end: { line: end, column: 10 },
});
const prepared: Prepared = {
	path: "script/a.ts", sha256: "a".repeat(64), mapHash: "b".repeat(64), code: "",
	statementMap: { a: range(1), b: range(2), c: range(2), d: range(3, 4) },
	fnMap: {},
};
test("CRAP bound credits only a uniquely mapped entire executed source line", () => {
	const source = "value = 1;\nleft(); right();\nmultiline(\nvalue);\n";
	const counters = conservativeCounters(prepared, source, new Map([[1, 4], [2, 8], [3, 2]]));
	expect(counters.s).toEqual({ a: 1, b: 0, c: 0, d: 0 });
	expect(counters.f).toEqual({});
});
test("missing native line evidence is explicitly an unproven lower bound", () => {
	expect(conservativeCounters(prepared, "", new Map<number, number>()).s).toEqual({ a: 0, b: 0, c: 0, d: 0 });
	expect(conservativeCounters(prepared, "value = 1; other();", new Map([[1, 1]])).s.a).toBe(0);
});
