import { analyzeJavascript } from "./quality-metrics/javascript";
import { analyzePython } from "./quality-metrics/python";
import { detectClones } from "./quality-metrics/clones";
import { joinCoverage, prepare } from "./quality-metrics/coverage";
import { loadInventory, toolVersion, type Source } from "./quality-metrics/input";
import { toolReceipts } from "./quality-metrics/tool";
import { qualitySource } from "./quality-source";
import { conservativeCounters } from "./quality-ci-bound";
import { requireMeasurement, type Finding, type Identity, type Measurement } from "./quality-ci-receipt";
import { digest, InventoryError } from "./quality-inventory";

function sourceLocation(source: Source, line: number, hosts: readonly Source[]) {
	if (!source.hostPath) return { path: source.path, line };
	const host = hosts.find((file) => file.path === source.hostPath);
	if (!host || source.hostOffset === undefined) throw new InventoryError("identity", source.path, "embedded host missing");
	return { path: host.path, line: line + host.text.slice(0, source.hostOffset).split("\n").length - 1 };
}

function metricPins() {
	return [
		["typescript", "5.9.2"], ["eslint", "9.36.0"],
		["@typescript-eslint/parser", "8.44.0"], ["eslint-plugin-sonarjs", "3.0.5"],
		["jscpd", "4.0.5"], ["@jscpd/core", "4.0.1"], ["@jscpd/tokenizer", "4.0.1"],
		["istanbul-lib-instrument", "6.0.3"],
	].map(([name = "", version = ""]) => toolVersion(name, version));
}
function thresholds(record: ReturnType<typeof joinCoverage>[number], coverageSelected: boolean): Finding[] {
	return ([
		["cyclomatic", record.cyclomatic, 22],
		["cognitive", record.cognitive, 22],
		["halstead", record.halstead.difficulty, 80],
		["crap", record.crap, 25],
	] as const).filter(([gate, value, limit]) => value >= limit && (gate !== "crap" || coverageSelected)).map(([gate, value]) => ({
		gate, path: record.path, line: record.line, endLine: record.endLine,
		symbol: `${record.kind}:${record.name}`, value,
	}));
}
function cloneFindings(duplication: Awaited<ReturnType<typeof detectClones>>, sources: Source[], hosts: Source[]): Finding[] {
	const findings: Finding[] = [];
	for (const cluster of duplication.clusters) {
		for (const partition of cluster.partition.filter((value) => value !== "historical")) {
			for (const occurrence of cluster.occurrences) {
				const source = sources.find((entry) => entry.path === occurrence.path);
				if (!source) throw new InventoryError("identity", occurrence.path, "clone source missing");
				findings.push({
					gate: partition === "production" ? "productionClones" : "testClones",
					...sourceLocation(source, occurrence.startLine, hosts), endLine: sourceLocation(source, occurrence.endLine, hosts).line,
					symbol: cluster.tokenHash, value: cluster.tokenCount,
				});
			}
		}
	}
	return findings;
}
export async function measureStatic(options: { root: string; inventory: string; scope?: readonly string[] }) {
	requireMeasurement(["1.3.6", "1.4.1"].includes(Bun.version), "unsupported Bun runtime");
	const tools = metricPins();
	const inventory = loadInventory(options.root, options.inventory);
	const sources = [...inventory.files.filter((source) => qualitySource(source.path)), ...inventory.embedded.filter((source) => source.hostPath && qualitySource(source.hostPath))];
	const measured = sources.filter((source) => options.scope === undefined || options.scope.includes(source.hostPath ?? source.path)).map((source) => {
		const analysis = source.language === "python" ? analyzePython(source) : {
			units: analyzeJavascript(source), prepared: prepare(source), receipt: null,
		};
		return { source, analysis };
	});
	const duplication = await detectClones(sources);
	return {
		version: 1, complete: true,
		inventoryHash: inventory.inventoryHash, contractHash: inventory.contractHash,
		tools, analyzerProcesses: toolReceipts(),
		pythonProcesses: measured.flatMap((row) => row.analysis.receipt ? [row.analysis.receipt] : []),
		sources: sources.map((row) => ({ path: row.path, sha256: row.sha256 })),
		hosts: inventory.files, measured, duplication,
		...(options.scope === undefined ? {} : { cloneSources: sources }),
	};
}
export type StaticDocument = Awaited<ReturnType<typeof measureStatic>>;

export function joinBounds(document: StaticDocument, options: {
	identity: Pick<Identity, "inventoryHash" | "contractHash">;
	lines: ReadonlyMap<string, ReadonlyMap<number, number>>; selectedLanes?: readonly string[];
}) {
	requireMeasurement(document.version === 1 && document.complete === true, "incomplete static metrics");
	requireMeasurement(document.inventoryHash === options.identity.inventoryHash && document.contractHash === options.identity.contractHash, "stale quality leg: metrics");
	const { hosts, duplication } = document;
	const sources = document.measured.map((row) => row.source);
	const measured = document.measured.map(({ source, analysis }) => {
		const counters = conservativeCounters(
			analysis.prepared, source.text, options.lines.get(source.path) ?? new Map<number, number>(),
		);
		return {
			source, analysis, counters,
			records: joinCoverage(source, analysis.units, analysis.prepared, counters),
		};
	});
	const records = measured.flatMap((row) => row.records);
	const selected = (path: string) => options.selectedLanes === undefined || options.selectedLanes.some((lane) => path.startsWith(`${lane}/`));
	const findings: Finding[] = measured.flatMap(({ source, records }) => records.flatMap((record) => thresholds(record, selected(source.hostPath ?? source.path)).map((finding) => ({
		...finding, ...sourceLocation(source, finding.line, hosts),
		endLine: sourceLocation(source, finding.endLine ?? finding.line, hosts).line,
		symbol: source.hostPath ? `PYTHON_DRIVER:${finding.symbol}` : finding.symbol,
	}))));
	// Every unproven original statement remains visible, including tests and files
	// without native LCOV. This is a conservative coverage deficit, not measured 0%.
	for (const { source, analysis, counters } of measured) {
		if (!selected(source.hostPath ?? source.path)) continue;
		for (const [id, span] of Object.entries(analysis.prepared.statementMap)) {
			if (counters.s[id] !== 0) continue;
			const text = source.text.split("\n").slice(span.start.line - 1, span.end.line).join("\n");
			findings.push({
				gate: "coverage", ...sourceLocation(source, span.start.line, hosts), endLine: sourceLocation(source, span.end.line, hosts).line,
				symbol: `unproven-statement:${digest(text)}`, value: 1,
			});
		}
	}
	findings.push(...cloneFindings(duplication, document.cloneSources ?? sources, hosts));
	const measurement: Measurement = {
		analyzed: ["cyclomatic", "cognitive", "halstead", "crap", "productionClones", "testClones", "coverage"],
		findings,
	};
	return {
		version: 1, complete: true, algorithm: "d945-lcov-crap-upper-bound@1",
		coverageMeaning: "proven-statement lower bound; unproven is not measured zero",
		coverageScope: options.selectedLanes ?? ["all"],
		inventoryHash: document.inventoryHash, contractHash: document.contractHash,
		tools: document.tools, analyzerProcesses: document.analyzerProcesses,
		pythonProcesses: document.pythonProcesses, sources: document.sources,
		records, duplication, measurement,
	};
}
