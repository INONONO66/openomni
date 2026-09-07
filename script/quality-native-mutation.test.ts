import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMutation } from "./quality-native-mutation";
import { digest } from "./quality-inventory";

test("mutation normalization rejects pilots missing candidates and stale killed sources", () => {
	const root = mkdtempSync(join(tmpdir(), "quality-mutation-receipt-"));
	const source = "export const enabled = true;\n", path = "script/a.ts";
	const identity = { inventoryHash: "a".repeat(64), contractHash: "b".repeat(64), paths: [path], typescript: [path] };
	const result = {
		selected: true, restored: true, outcome: "killed", path,
		sourceSha256: digest(source), startOffset: 23, endOffset: 27,
		operator: "boolean", replacementSha256: digest("false"),
	};
	const receipt = {
		version: 1, complete: true, full: true, originalHashesVerified: true, cleanupVerified: true,
		inventorySha256: identity.inventoryHash, errors: [], results: [result],
		counts: { killed: 1, survived: 0, noCoverage: 0, invalid: 0, infrastructure: 0, uncompleted: 0 },
		census: [{ path, sha256: digest(source), operators: [{ candidates: 1 }] }],
	};
	try {
		mkdirSync(join(root, "script"));
		writeFileSync(join(root, path), source);
		expect(normalizeMutation(receipt, identity, root).findings).toEqual([]);
		for (const changed of [
			{ ...receipt, full: false }, { ...receipt, complete: false }, { ...receipt, census: [] },
			{ ...receipt, results: [] }, { ...receipt, counts: { ...receipt.counts, killed: 2 } },
			{ ...receipt, results: [{ ...result, selected: false }] },
			{ ...receipt, results: [{ ...result, sourceSha256: "c".repeat(64) }] },
		]) expect(() => normalizeMutation(changed, identity, root)).toThrow();
		const survived = {
			...receipt, results: [{ ...result, outcome: "survived" }],
			counts: { ...receipt.counts, killed: 0, survived: 1 },
		};
		expect(normalizeMutation(survived, identity, root).findings).toHaveLength(1);
		writeFileSync(join(root, path), `${source}// changed\n`);
		expect(() => normalizeMutation(receipt, identity, root)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("embedded Python mutants retain original host coordinates and cannot disappear at normalization", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-embedded-mutant-"));
  try {
    const hostPath = "packages/machines/src/kernel.ts", path = `${hostPath}#PYTHON_DRIVER`;
    const source = "print(True)\n";
    const identity = { inventoryHash: "a".repeat(64), contractHash: "b".repeat(64), paths: [hostPath], typescript: [hostPath], embedded: [{ path, hostPath, text: source, sha256: digest(source), lineOffset: 10 }] };
    const result = { selected: true, restored: true, outcome: "survived", path, sourceSha256: digest(source), startOffset: 6, endOffset: 10, operator: "py-boolean", replacementSha256: digest("False") };
    const receipt = { version: 1, complete: true, full: true, originalHashesVerified: true, cleanupVerified: true, inventorySha256: identity.inventoryHash, errors: [], results: [result], counts: { killed: 0, survived: 1, noCoverage: 0, invalid: 0, infrastructure: 0, uncompleted: 0 }, census: [{ path: hostPath, operators: [{ candidates: 0 }] }, { path, operators: [{ candidates: 1 }] }] };
    expect(normalizeMutation(receipt, identity, root).findings).toEqual([{ gate: "mutation", path: hostPath, line: 11, symbol: `PYTHON_DRIVER:py-boolean:${digest("False")}:True`, value: 1 }]);
    expect(() => normalizeMutation({ ...receipt, census: receipt.census.slice(0, 1) }, identity, root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
