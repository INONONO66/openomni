import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { digest } from "./quality-inventory";
import { fingerprint, recordObject } from "./quality-ci-input";
import { requireMeasurement } from "./quality-ci-receipt";
import { parseNativeLcov } from "./quality-native-lcov";
import { coverageLanes } from "./topology";

export { parseNativeLcov } from "./quality-native-lcov";

export function coverageRecord(mode: "begin" | "finish", options: {
	root: string; contract: string; lane: string; run: string; output: string;
}) {
	requireMeasurement(coverageLanes().some((lane) => lane.dir === options.lane), "unknown coverage lane");
	requireMeasurement(options.run.length > 0, "missing CI run identity");
	const identity = fingerprint(options.root, options.contract);
	const report = resolve(options.root, options.lane, "coverage/lcov.info");
	const output = resolve(options.root, options.output);
	const stamp = {
		version: 1, run: options.run, lane: options.lane,
		inventoryHash: identity.inventoryHash, runtime: Bun.version,
	};
	if (mode === "begin") {
		requireMeasurement(!existsSync(report), "stale LCOV exists before test execution");
		writeFileSync(`${output}.start`, JSON.stringify(stamp), { flag: "wx" });
		return;
	}
	const started = recordObject(`${output}.start`);
	requireMeasurement(JSON.stringify(started) === JSON.stringify(stamp), "source, runtime or run changed during collection");
	const lcov = readFileSync(report, "utf8");
	const files = parseNativeLcov(lcov, options.lane);
	const result = { ...stamp, complete: true, lcovHash: digest(lcov), lcov, files };
	writeFileSync(output, JSON.stringify(result), { flag: "wx" });
	return result;
}
if (import.meta.main) {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2), strict: true, allowPositionals: true,
		options: {
			root: { type: "string", default: process.cwd() },
			contract: { type: "string", default: "script/conformance/quality-contract.json" },
			lane: { type: "string" }, run: { type: "string" }, output: { type: "string" },
		},
	});
	const mode = positionals[0];
	requireMeasurement(positionals.length === 1 && (mode === "begin" || mode === "finish"), "expected begin or finish");
	coverageRecord(mode === "begin" ? "begin" : "finish", {
		root: values.root, contract: values.contract,
		lane: values.lane ?? "", run: values.run ?? "", output: values.output ?? "",
	});
}
