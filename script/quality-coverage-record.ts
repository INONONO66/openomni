import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { digest, jsonString } from "./quality-inventory";
import { scriptPartitions } from "./scripts-lanes";
import { fingerprint, recordObject } from "./quality-ci-input";
import { requireMeasurement } from "./quality-ci-receipt";
import { parseNativeLcov } from "./quality-native-lcov";
import { coverageLanes } from "./topology";

export { parseNativeLcov } from "./quality-native-lcov";

export function coverageRecord(mode: "begin" | "finish" | "merge", options: {
	root: string; contract: string; lane: string; run: string; output: string; partition?: string; directory?: string;
}) {
	requireMeasurement(coverageLanes().some((lane) => lane.dir === options.lane), "unknown coverage lane");
	requireMeasurement(options.run.length > 0, "missing CI run identity");
	const identity = fingerprint(options.root, options.contract);
	const report = resolve(options.root, options.lane, "coverage/lcov.info");
	const output = resolve(options.root, options.output);
	if (options.partition) requireMeasurement(options.lane === "script" && scriptPartitions.some((part) => part === options.partition), "invalid coverage partition");
	const stamp = {
		version: 1, run: options.run, lane: options.lane,
		inventoryHash: identity.inventoryHash, runtime: Bun.version,
		...(options.partition ? { partition: options.partition } : {}),
	};
	if (mode === "merge") {
		requireMeasurement(options.lane === "script" && !options.partition && Boolean(options.directory), "merge requires script partitions");
		const counters = new Map<string, Map<number, number>>();
		for (const partition of scriptPartitions) {
			const row = recordObject(resolve(options.root, options.directory ?? "", `${partition}.json`));
			requireMeasurement(row.complete === true && row.partition === partition && Object.entries(stamp).every(([key, value]) => row[key] === value), `stale coverage partition: ${partition}`);
			const lcov = jsonString(row.lcov);
			requireMeasurement(row.lcovHash === digest(lcov), `changed coverage partition: ${partition}`);
			const files = parseNativeLcov(lcov, options.lane);
			requireMeasurement(JSON.stringify(files) === JSON.stringify(row.files), `changed coverage lines: ${partition}`);
			for (const file of files) {
				const lines = counters.get(file.path) ?? new Map<number, number>();
				for (const row of file.lines) lines.set(row.line, Math.max(lines.get(row.line) ?? 0, row.hits));
				counters.set(file.path, lines);
			}
		}
		const lcov = [...counters].sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) => {
			const records = [...lines].sort(([a], [b]) => a - b);
			return `SF:${relative(options.lane, path)}\n${records.map(([line, hits]) => `DA:${line},${hits}`).join("\n")}\nLF:${records.length}\nLH:${records.filter(([, hits]) => hits > 0).length}\nend_of_record\n`;
		}).join("");
		mkdirSync(dirname(report), { recursive: true });
		writeFileSync(report, lcov, { flag: "wx" });
		const result = { ...stamp, complete: true, lcovHash: digest(lcov), lcov, files: parseNativeLcov(lcov, options.lane), partitions: scriptPartitions };
		writeFileSync(output, JSON.stringify(result), { flag: "wx" });
		return result;
	}
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
			partition: { type: "string" }, directory: { type: "string" },
		},
	});
	const mode = positionals[0];
	requireMeasurement(positionals.length === 1 && (mode === "begin" || mode === "finish" || mode === "merge"), "expected begin, finish or merge");
	coverageRecord(mode === "begin" ? "begin" : mode === "merge" ? "merge" : "finish", {
		root: values.root, contract: values.contract,
		lane: values.lane ?? "", run: values.run ?? "", output: values.output ?? "", partition: values.partition, directory: values.directory,
	});
}
