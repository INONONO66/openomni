import { expect, test } from "bun:test";
import { normalizeTypes, normalizeCensus, mergeMeasurements } from "./quality-ci-receipt";
import { regressions } from "./quality-ratchet";

const identity = {
	inventoryHash: "a".repeat(64),
	contractHash: "b".repeat(64),
	paths: ["script/example.ts"],
	typescript: ["script/example.ts"],
};
const types = {
	version: 1, complete: true, tool: "typescript@5.9.2",
	inventoryHash: identity.inventoryHash,
	measured: identity.paths, semanticMeasured: identity.paths,
	errors: [], violations: [],
};

test("complete native types yield a genuinely clean normalized receipt", () => {
	const receipt = mergeMeasurements(identity.paths, [normalizeTypes(types, identity)]);
	expect(receipt.complete).toBe(true);
	expect(receipt.analyzed).toEqual(["type"]);
	expect(receipt.findings).toEqual([]);
	expect(regressions(receipt, receipt, new Set())).toEqual([]);
});

test("missing incomplete and stale native type receipts never normalize to zero", () => {
	for (const changed of [
		{}, { ...types, complete: false }, { ...types, inventoryHash: "c".repeat(64) },
		{ ...types, measured: [] }, { ...types, semanticMeasured: [] },
		{ ...types, errors: [{ code: "resolution" }] },
	]) expect(() => normalizeTypes(changed, identity)).toThrow();
});

test("native type findings retain identity and trigger growth and changed-file ratchets", () => {
	const violation = { path: "script/example.ts", line: 4, kind: "implicitAny", symbol: "value", offset: 10 };
	const native = { ...types, violations: [violation] };
	const base = mergeMeasurements(identity.paths, [normalizeTypes(native, identity)]);
	const doubled = mergeMeasurements(identity.paths, [normalizeTypes({ ...native, violations: [violation, violation] }, identity)]);
	expect(regressions(base, doubled, new Set()).length).toBe(2);
	expect(regressions(base, base, new Set(identity.paths))).toHaveLength(1);
	const clean = mergeMeasurements(identity.paths, [normalizeTypes(types, identity)]);
	expect(regressions(clean, base, new Set())).toHaveLength(1);
});

test("census normalizer rejects wrong class counts and incomplete provenance", () => {
	const census = {
		version: 1, complete: true, class: "publisher", analyzedClasses: ["publisher"],
		inventoryHash: identity.inventoryHash, contractHash: identity.contractHash,
		counts: { publisher: 0, export: 0, store: 0 }, errors: [], findings: [],
	};
	expect(normalizeCensus(census, identity, "publisher").findings).toEqual([]);
	for (const changed of [
		{ ...census, complete: false }, { ...census, class: "export" },
		{ ...census, counts: { publisher: 1, export: 0, store: 0 } },
		{ ...census, contractHash: "d".repeat(64) }, { ...census, analyzedClasses: [] },
	]) expect(() => normalizeCensus(changed, identity, "publisher")).toThrow();
	expect(() => mergeMeasurements(identity.paths, [
		normalizeCensus(census, identity, "publisher"),
		normalizeCensus(census, identity, "publisher"),
	])).toThrow();
});
