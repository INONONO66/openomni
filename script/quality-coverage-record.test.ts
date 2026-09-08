import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNativeLcov, coverageRecord } from "./quality-coverage-record";

const lcov = "TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n";

test("LCOV preserves native line counts without inventing statement hits", () => {
	expect(parseNativeLcov(lcov, "packages/example")).toEqual([
		{ path: "packages/example/src/a.ts", lines: [{ line: 1, hits: 1 }, { line: 2, hits: 0 }] },
	]);
	for (const malformed of [
		"", lcov.replace("LH:1", "LH:2"), lcov.replace("LF:2", "LF:3"),
		lcov.replace("DA:2,0", "DA:1,0"), lcov.replace("DA:2,0", "DA:2,-1"),
		lcov.replace("end_of_record\n", ""), lcov + lcov,
		lcov.replace("src/a.ts", "../../../escape.ts"),
	]) expect(() => parseNativeLcov(malformed, "packages/example")).toThrow();
});

test("script shards merge native counters only after all four fresh partitions arrive", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-shards-"));
  const options = { root, lane: "script", contract: "contract.json", run: "run-1", output: "merged.json", directory: "partitions" };
  try {
    mkdirSync(join(root, "script/coverage"), { recursive: true });
    mkdirSync(join(root, "partitions"));
    writeFileSync(join(root, "script/a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "script/tsconfig.json"), '{"include":["*.ts"]}');
    writeFileSync(join(root, "contract.json"), JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false }));
    for (const partition of ["scripts-contracts", "scripts-tooling-1", "scripts-tooling-2", "scripts-tooling-3"]) {
      expect(() => coverageRecord("merge", options)).toThrow();
      const part = { ...options, partition, output: `partitions/${partition}.json` };
      coverageRecord("begin", part);
      writeFileSync(join(root, "script/coverage/lcov.info"), lcov.replace("src/a.ts", "a.ts").replace("DA:1,1", partition === "scripts-tooling-2" ? "DA:1,3" : "DA:1,1"));
      coverageRecord("finish", part);
      rmSync(join(root, "script/coverage/lcov.info"));
    }
    const result = coverageRecord("merge", options);
    expect(result?.files[0]?.lines).toEqual([{ line: 1, hits: 3 }, { line: 2, hits: 0 }]);
    expect(() => coverageRecord("merge", { ...options, run: "other", output: "bad.json" })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage begin and finish bind a new report to source bytes and run identity", () => {
	const root = mkdtempSync(join(tmpdir(), "quality-record-"));
	const options = { root, lane: "script", contract: "contract.json", run: "run-1", output: "receipt.json" };
	try {
		mkdirSync(join(root, "script/coverage"), { recursive: true });
		writeFileSync(join(root, "script/a.ts"), "export const a = 1;\n");
		writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{},"include":["*.ts"]}');
		writeFileSync(join(root, "contract.json"), JSON.stringify({
			version: 1, typescript: "5.9.2", roots: ["script"],
			projects: ["script/tsconfig.json"], topology: false,
		}));
		expect(() => coverageRecord("finish", options)).toThrow();
		coverageRecord("begin", options);
		expect(() => coverageRecord("finish", options)).toThrow();
		writeFileSync(join(root, "script/coverage/lcov.info"), lcov.replace("src/a.ts", "a.ts"));
		expect(() => coverageRecord("finish", { ...options, run: "other" })).toThrow();
		writeFileSync(join(root, "script/a.ts"), "export const a = 2;\n");
		expect(() => coverageRecord("finish", options)).toThrow();
		writeFileSync(join(root, "script/a.ts"), "export const a = 1;\n");
		const result = coverageRecord("finish", options);
		expect(result?.complete).toBe(true);
		expect(() => coverageRecord("finish", options)).toThrow();
		expect(() => coverageRecord("begin", { ...options, output: "other.json" })).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
