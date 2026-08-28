import { describe, expect, test } from "bun:test";
import { topologyProblems, type TopologyConsumer } from "./check-topology";
import { TOPOLOGY, type WorkspaceTopology } from "./topology";

const consumers: readonly TopologyConsumer[] = [
  "dependency-bands",
  "import-cycles",
  "knip",
  "dead-exports",
  "ci-tests",
  "coverage-ratchet",
  "tsconfig",
];

const phantom: WorkspaceTopology = {
  key: "phantom",
  displayName: "phantom",
  dir: "packages/phantom",
  packageName: "@openomni/phantom",
  allowedDeps: ["@openomni/protocol"],
  testLane: true,
  // Explicitly skipped just like machines: coverage still has to account for
  // the workspace and reject its missing package boundary.
  coverageLane: false,
  knipWorkspace: true,
  tsconfigVerify: true,
};

describe("topology conformance", () => {
  test("the checked-in manifest conforms to every structural consumer", () => {
    const problems = topologyProblems();
    for (const consumer of consumers) expect(problems[consumer]).toEqual([]);
  });

  test("a phantom manifest package is noticed by every consumer", () => {
    const problems = topologyProblems([...TOPOLOGY, phantom]);
    const proof = Object.fromEntries(
      consumers.map((consumer) => [consumer, problems[consumer].join(" | ")]),
    );
    process.stdout.write(`PHANTOM-PROOF ${JSON.stringify(proof)}\n`);
    for (const consumer of consumers) {
      expect(problems[consumer].length, `${consumer} silently ignored phantom`).toBeGreaterThan(0);
    }
  });
});
