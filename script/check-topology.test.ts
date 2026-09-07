import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { topologyProblems, type TopologyConsumer } from "./check-topology";
import { assertTopologyComplete, ciTestSteps, TOPOLOGY, type WorkspaceTopology } from "./topology";

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

const fixtureRoots: string[] = [];
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "topology-consumers-"));
  fixtureRoots.push(root);
  const workspace: WorkspaceTopology = { ...phantom, allowedDeps: [], coverageLane: true };
  const files = {
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/phantom/package.json": JSON.stringify({ name: workspace.packageName }),
    "packages/phantom/src/index.ts": "export const value = 1;",
    "packages/phantom/test/index.test.ts": "",
    "packages/phantom/tsconfig.json": "{}",
    "knip.json": JSON.stringify({ workspaces: { ".": {}, [workspace.dir]: {} } }),
    "script/conformance/coverage-baseline.json": JSON.stringify({
      [workspace.dir]: {},
      script: {},
    }),
    ".github/workflows/ci.yml": [
      "      # topology:test-steps:start",
      ciTestSteps([workspace]),
      "      # topology:test-steps:end",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, workspace };
}

const damagedConsumers: readonly {
  readonly name: string;
  readonly affected: readonly TopologyConsumer[];
  readonly damage: (root: string, workspace: WorkspaceTopology) => WorkspaceTopology;
}[] = [
  {
    name: "package identity",
    affected: ["dependency-bands"],
    damage(root, workspace) {
      writeFileSync(join(root, workspace.dir, "package.json"), '{"name":"wrong"}');
      return workspace;
    },
  },
  {
    name: "source inventory",
    affected: ["import-cycles"],
    damage(root, workspace) {
      rmSync(join(root, workspace.dir, "src/index.ts"));
      return workspace;
    },
  },
  {
    name: "project inventory",
    affected: ["tsconfig"],
    damage(root, workspace) {
      rmSync(join(root, workspace.dir, "tsconfig.json"));
      return workspace;
    },
  },
  {
    name: "dependency target",
    affected: ["dependency-bands"],
    damage(_root, workspace) {
      return { ...workspace, allowedDeps: ["@openomni/missing"] };
    },
  },
  {
    name: "knip inventory",
    affected: ["knip", "dead-exports"],
    damage(root, workspace) {
      writeFileSync(join(root, "knip.json"), '{"workspaces":{".":{}}}');
      return workspace;
    },
  },
  {
    name: "CI test discovery",
    affected: ["ci-tests"],
    damage(root, workspace) {
      writeFileSync(join(root, ".github/workflows/ci.yml"), "");
      return workspace;
    },
  },
  {
    name: "coverage inventory",
    affected: ["coverage-ratchet"],
    damage(root, workspace) {
      writeFileSync(join(root, "script/conformance/coverage-baseline.json"), '{"script":{}}');
      return workspace;
    },
  },
];

describe("topology conformance", () => {
  for (const { name, affected, damage } of damagedConsumers) {
    test(`detects damaged ${name} with the workspace inventory intact`, () => {
      const { root, workspace } = fixture();
      for (const problems of Object.values(topologyProblems([workspace], root))) {
        expect(problems).toEqual([]);
      }
      const damaged = damage(root, workspace);
      expect(() => assertTopologyComplete([damaged], root)).not.toThrow();
      const problems = topologyProblems([damaged], root);
      for (const consumer of consumers) {
        if (affected.includes(consumer)) expect(problems[consumer].length).toBeGreaterThan(0);
        else expect(problems[consumer]).toEqual([]);
      }
    });
  }

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

  test("an omitted on-disk workspace is noticed by every consumer", () => {
    const omitted = TOPOLOGY.filter((workspace) => workspace.key !== "machines");
    expect(() => assertTopologyComplete(omitted)).toThrow("packages/machines");

    const problems = topologyProblems(omitted);
    const proof = Object.fromEntries(
      consumers.map((consumer) => [consumer, problems[consumer].join(" | ")]),
    );
    process.stdout.write(`OMISSION-PROOF ${JSON.stringify(proof)}\n`);
    for (const consumer of consumers) {
      expect(problems[consumer].length, `${consumer} silently ignored omission`).toBeGreaterThan(0);
      expect(problems[consumer].join(" | ")).toContain("packages/machines");
    }
  });
});
