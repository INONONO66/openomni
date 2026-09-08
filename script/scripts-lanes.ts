import { join } from "node:path";

/** Explicit, recursive inventory. New tests require an ownership decision. */
export const scriptsLanes = {
  "scripts-contracts": [
    "alarm-type-contract.test.ts",
    "benchmark-workflow.test.ts",
    "check-topology.test.ts",
    "ci-plan.test.ts",
    "ci.test.ts",
    "conformance/ledger-producer-drift.test.ts",
    "conformance/lint-side-effects.test.ts",
    "conformance/protocol-event-pairing.test.ts",
    "conformance/request-authority-census.test.ts",
    "gate-discovery.test.ts",
    "generate-ledger-archive-manifest.test.ts",
    "ledger-archive-fault.test.ts",
    "ledger-archive-review-r2.test.ts",
    "lint-tools.test.ts",
    "scripts-lanes.test.ts",
    "tool-target-deletion.test.ts",
    "verify-tsconfig-inheritance.test.ts",
  ],
  "scripts-tooling": [
    "census-program.test.ts",
    "check-census.test.ts",
    "check-quality-coverage.test.ts",
    "check-quality-metrics.test.ts",
    "check-quality-python.test.ts",
    "check-types-census.test.ts",
    "conformance/summarize-benchmark-runs.test.ts",
    "coverage-ratchet.test.ts",
    "coverage-source-inventory.test.ts",
    "quality-ci-bound.test.ts",
    "quality-ci-coverage.test.ts",
    "quality-ci-legs.test.ts",
    "quality-ci-metrics.test.ts",
    "quality-ci-receipt.test.ts",
    "quality-coverage-record.test.ts",
    "quality-inventory.test.ts",
    "quality-json.test.ts",
    "quality-measure.test.ts",
    "quality-metrics/declaration-erasure.test.ts",
    "quality-metrics/tool.test.ts",
    "quality-metrics/type-trivia.test.ts",
    "quality-mutation-workflow.test.ts",
    "quality-native-mutation.test.ts",
    "quality-native-process.test.ts",
    "quality-plan.test.ts",
    "quality-ratchet.test.ts",
    "quality-schema.test.ts",
    "quality-source.test.ts",
    "run-quality-mutations.test.ts",
  ],
} as const;
export type ScriptsLane = keyof typeof scriptsLanes;
export const scriptPartitions = ["scripts-contracts", "scripts-tooling-1", "scripts-tooling-2", "scripts-tooling-3"] as const;
export const scriptContracts = [
  ["check-dead-exports.ts", "--self-test"],
  ["check-deps.ts", "--self-test"],
  ["check-import-cycles.ts", "--self-test"],
  ["verify-ledger-rename.ts"],
  ["check-ledger-schema-drift.ts"],
] as const;
export function scriptTests(lane: ScriptsLane, actual = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: import.meta.dir })]): readonly string[] {
  const assigned = Object.values(scriptsLanes).flat();
  const missing = actual.filter((path) => !assigned.some((entry) => entry === path));
  const absent = assigned.filter((path) => !actual.includes(path));
  if (missing.length || absent.length || new Set(assigned).size !== assigned.length) {
    throw new Error(`script test lane drift: ${[...missing, ...absent].join(", ")}`);
  }
  return scriptsLanes[lane];
}
export function scriptTestCommand(partition: string) {
  if (!scriptPartitions.some((key) => key === partition)) throw new Error(`invalid script partition: ${partition}`);
  const tooling = partition !== "scripts-contracts";
  const tests = scriptTests(tooling ? "scripts-tooling" : "scripts-contracts");
  return ["bun", "test", ...tests.map((path) => `./${path}`), "--timeout", "15000", "--coverage", "--coverage-reporter=lcov", "--coverage-dir=coverage", ...(tooling ? [`--shard=${partition.slice(-1)}/3`, `--timings=${join("coverage", "timings.json")}`, "--update-timings"] : [])];
}
