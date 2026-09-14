import { resolve } from "node:path";
import { buildInventory, decodeJson, digest, jsonObject, jsonString, readContract } from "./quality-inventory";
import { qualitySource } from "./quality-source";
import type { CiPlan } from "./ci-plan";

type Proof = {
	readonly sha256: ReadonlyMap<string, string>;
};

function readBaseline(root: string, base: string): Proof {
	const result = Bun.spawnSync(["git", "show", `${base}:script/conformance/quality-baseline-lcov-bound.json`], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`cannot read quality baseline at ${base}`);
	const document = jsonObject(decodeJson(result.stdout.toString()));
	const raw = document.sha256 === undefined ? {} : jsonObject(document.sha256);
	return {
		sha256: new Map(Object.entries(raw).map(([path, value]) => [path, jsonString(value)])),
	};
}
function sourceAt(root: string, base: string, path: string): string | undefined {
	const result = Bun.spawnSync(["git", "show", `${base}:${path}`], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

export function hasCompleteQualityProof(root: string, base: string, plan: CiPlan): boolean {
	if (!plan.verify || plan.toolingTests || plan.full) return true;
	const proof = readBaseline(root, base);
	const contract = readContract(resolve(root, "script/conformance/quality-contract.json"));
	const inventory = buildInventory(root, contract);
	const selected = new Set(plan.qualityScope);
	return inventory.files
		.filter((source) => qualitySource(source.path))
		.every((source) => {
			if (selected.has(source.path)) return true;
			const expected = proof.sha256.get(source.path);
			const baseSource = sourceAt(root, base, source.path);
			return expected !== undefined && baseSource !== undefined && digest(baseSource) === expected;
		});
}
