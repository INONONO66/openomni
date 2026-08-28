import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ciTestSteps,
  coverageWorkspaces,
  knipWorkspaces,
  TOPOLOGY,
  tsconfigWorkspaces,
  type WorkspaceTopology,
} from "./topology";

export type TopologyConsumer =
  | "dependency-bands"
  | "import-cycles"
  | "knip"
  | "dead-exports"
  | "ci-tests"
  | "coverage-ratchet"
  | "tsconfig";

export type TopologyProblems = Record<TopologyConsumer, string[]>;

const CONSUMERS: readonly TopologyConsumer[] = [
  "dependency-bands",
  "import-cycles",
  "knip",
  "dead-exports",
  "ci-tests",
  "coverage-ratchet",
  "tsconfig",
];

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function topologyProblems(
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
  root = join(import.meta.dir, ".."),
): TopologyProblems {
  const problems: TopologyProblems = {
    "dependency-bands": [],
    "import-cycles": [],
    knip: [],
    "dead-exports": [],
    "ci-tests": [],
    "coverage-ratchet": [],
    tsconfig: [],
  };
  const dirs = new Set<string>();
  const names = new Set<string>();

  for (const workspace of topology) {
    if (dirs.has(workspace.dir)) {
      problems["dependency-bands"].push(`duplicate workspace dir ${workspace.dir}`);
    }
    if (names.has(workspace.packageName)) {
      problems["dependency-bands"].push(`duplicate package name ${workspace.packageName}`);
    }
    dirs.add(workspace.dir);
    names.add(workspace.packageName);

    const manifestPath = join(root, workspace.dir, "package.json");
    if (!existsSync(manifestPath)) {
      problems["dependency-bands"].push(`${workspace.dir} has no package.json`);
      problems["coverage-ratchet"].push(`${workspace.dir} has no package.json`);
    } else {
      const manifest = json(manifestPath);
      if (manifest.name !== workspace.packageName) {
        problems["dependency-bands"].push(
          `${workspace.dir} package name is ${String(manifest.name)}, expected ${workspace.packageName}`,
        );
      }
    }

    const sourceDir = join(root, workspace.dir, "src");
    const sourceCount = existsSync(sourceDir)
      ? [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: sourceDir, onlyFiles: true })].length
      : 0;
    if (sourceCount === 0) {
      problems["import-cycles"].push(`${workspace.dir} contributes zero source modules`);
    }

    for (const sourceRoot of ["src", "test", ...(workspace.extraSourceRoots ?? [])]) {
      if (!existsSync(join(root, workspace.dir, sourceRoot))) {
        problems.tsconfig.push(`${workspace.dir}/${sourceRoot} is missing`);
      }
    }
    const projectCount = existsSync(join(root, workspace.dir))
      ? [...new Bun.Glob("**/tsconfig*.json").scanSync({ cwd: join(root, workspace.dir), onlyFiles: true })]
          .length
      : 0;
    if (workspace.tsconfigVerify && projectCount === 0) {
      problems.tsconfig.push(`${workspace.dir} contributes zero tsconfig projects`);
    }
  }

  for (const workspace of topology) {
    if (Array.isArray(workspace.allowedDeps)) {
      for (const dependency of workspace.allowedDeps) {
        if (!names.has(dependency)) {
          problems["dependency-bands"].push(
            `${workspace.packageName} allows unknown topology dependency ${dependency}`,
          );
        }
      }
    }
  }

  const actualWorkspaceDirs = [
    ...new Bun.Glob("{packages,apps}/*/package.json").scanSync({ cwd: root, onlyFiles: true }),
  ]
    .map((path) => path.replace(/\/package\.json$/, ""))
    .sort();
  const expectedWorkspaceDirs = [...dirs].sort();
  if (actualWorkspaceDirs.join("\n") !== expectedWorkspaceDirs.join("\n")) {
    problems["dependency-bands"].push(
      `workspace inventory drift: expected [${expectedWorkspaceDirs.join(", ")}], got [${actualWorkspaceDirs.join(", ")}]`,
    );
  }

  const knip = json(join(root, "knip.json"));
  const knipConfig = (knip.workspaces ?? {}) as Record<string, unknown>;
  const actualKnip = Object.keys(knipConfig).sort();
  const expectedKnip = [".", ...knipWorkspaces(topology).map((workspace) => workspace.dir)].sort();
  if (actualKnip.join("\n") !== expectedKnip.join("\n")) {
    const message = `expected [${expectedKnip.join(", ")}], got [${actualKnip.join(", ")}]`;
    problems.knip.push(message);
    problems["dead-exports"].push(message);
  }

  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const ciMatch = ci.match(
    / {6}# topology:test-steps:start[^\n]*\n([\s\S]*?) {6}# topology:test-steps:end/,
  );
  const expectedCi = `${ciTestSteps(topology)}\n`;
  if (!ciMatch || ciMatch[1] !== expectedCi) {
    problems["ci-tests"].push("generated topology test-step block is missing or stale");
  }

  const baseline = json(join(root, "script/conformance/coverage-baseline.json"));
  const expectedCoverage = coverageWorkspaces(topology).map((workspace) => workspace.dir).sort();
  const actualCoverage = Object.keys(baseline).sort();
  if (actualCoverage.join("\n") !== expectedCoverage.join("\n")) {
    problems["coverage-ratchet"].push(
      `baseline expected [${expectedCoverage.join(", ")}], got [${actualCoverage.join(", ")}]`,
    );
  }

  const tsconfigParticipants = tsconfigWorkspaces(topology).map((workspace) => workspace.dir);
  if (tsconfigParticipants.length === 0) {
    problems.tsconfig.push("topology contributes zero tsconfig workspaces");
  }

  return problems;
}

function main(): void {
  const problems = topologyProblems();
  const failures = CONSUMERS.flatMap((consumer) =>
    problems[consumer].map((problem) => `${consumer}: ${problem}`),
  );
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`VIOLATION [topology] ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `OK: topology conformance — ${TOPOLOGY.length} workspaces feed dependency, cycle, knip/dead-export, CI, coverage, and tsconfig gates\n`,
  );
}

if (import.meta.main) main();
