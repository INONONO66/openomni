import { join } from "node:path";

/** Explicit, recursive inventory. New tests require an ownership decision. */
export const scriptsLanes = {
  "scripts-contracts": [
    "alarm-type-contract.test.ts",
    "benchmark-workflow.test.ts",
    "check-benchmark-regression.test.ts",
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
    "check-census-native.test.ts",
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
    "run-quality-mutations-operators.test.ts",
  ],
} as const;
export type ScriptsLane = keyof typeof scriptsLanes;
export const scriptPartitions = ["scripts-contracts", "scripts-tooling-1", "scripts-tooling-2", "scripts-tooling-3", "scripts-tooling-4"] as const;
// Run 34324099419's scenario timings, packed with setup headroom below five minutes.
// Both census (365s) and mutation (332s) must split; three runners cannot fit the total.
export const scriptToolingPartitions = {
  "scripts-tooling-1": ["check-census-native.test.ts", "check-quality-coverage.test.ts", "quality-ratchet.test.ts", "quality-metrics/tool.test.ts", "quality-ci-metrics.test.ts", "quality-ci-legs.test.ts", "quality-schema.test.ts", "quality-json.test.ts", "quality-mutation-workflow.test.ts", "quality-inventory.test.ts", "quality-ci-receipt.test.ts", "quality-source.test.ts"],
  "scripts-tooling-2": ["check-census.test.ts", "quality-metrics/type-trivia.test.ts", "quality-measure.test.ts", "check-quality-python.test.ts", "coverage-source-inventory.test.ts", "conformance/summarize-benchmark-runs.test.ts", "quality-native-process.test.ts", "quality-coverage-record.test.ts", "quality-ci-coverage.test.ts", "quality-native-mutation.test.ts", "quality-plan.test.ts", "quality-ci-bound.test.ts"],
  "scripts-tooling-3": ["run-quality-mutations-operators.test.ts", "check-types-census.test.ts", "quality-metrics/declaration-erasure.test.ts", "census-program.test.ts", "coverage-ratchet.test.ts"],
  "scripts-tooling-4": ["run-quality-mutations.test.ts", "check-quality-metrics.test.ts"],
} as const;
export type ScriptToolingPartition = keyof typeof scriptToolingPartitions;
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
  const lane = scriptTests(tooling ? "scripts-tooling" : "scripts-contracts");
  const tests = tooling ? scriptToolingPartitions[partition as ScriptToolingPartition] : lane;
  return ["bun", "test", ...tests.map((path) => `./${path}`), "--timeout", "15000", "--coverage", "--coverage-reporter=lcov", "--coverage-dir=coverage", ...(tooling ? [`--timings=${join("coverage", "timings.json")}`, "--update-timings"] : [])];
}
