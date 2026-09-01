import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ciTestSteps,
  coverageWorkspaces,
  knipWorkspaces,
  TOPOLOGY,
  topologyInventoryDrift,
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

function emptyProblems(): TopologyProblems {
  return {
    "dependency-bands": [],
    "import-cycles": [],
    knip: [],
    "dead-exports": [],
    "ci-tests": [],
    "coverage-ratchet": [],
    tsconfig: [],
  };
}

function checkWorkspaceBoundary(
  workspace: WorkspaceTopology,
  root: string,
  problems: TopologyProblems,
  dirs: Set<string>,
  names: Set<string>,
): void {
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
    return;
  }
  const manifest = json(manifestPath);
  if (manifest.name !== workspace.packageName) {
    problems["dependency-bands"].push(
      `${workspace.dir} package name is ${String(manifest.name)}, expected ${workspace.packageName}`,
    );
  }
}

function checkWorkspaceSources(
  workspace: WorkspaceTopology,
  root: string,
  problems: TopologyProblems,
): void {
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
}

function checkWorkspaceProjects(
  workspace: WorkspaceTopology,
  root: string,
  problems: TopologyProblems,
): void {
  const workspaceDir = join(root, workspace.dir);
  const projectCount = existsSync(workspaceDir)
    ? [...new Bun.Glob("**/tsconfig*.json").scanSync({ cwd: workspaceDir, onlyFiles: true })]
        // Installed dependencies ship their own tsconfigs; counting them
        // would make this check pass vacuously for every workspace.
        .filter((path) => !path.includes("node_modules/")).length
    : 0;
  if (workspace.tsconfigVerify && projectCount === 0) {
    problems.tsconfig.push(`${workspace.dir} contributes zero tsconfig projects`);
  }
}

function checkAllowedDependencies(
  topology: readonly WorkspaceTopology[],
  names: ReadonlySet<string>,
  problems: TopologyProblems,
): void {
  for (const workspace of topology) {
    if (!Array.isArray(workspace.allowedDeps)) continue;
    for (const dependency of workspace.allowedDeps) {
      if (!names.has(dependency)) {
        problems["dependency-bands"].push(
          `${workspace.packageName} allows unknown topology dependency ${dependency}`,
        );
      }
    }
  }
}

function checkInventory(
  topology: readonly WorkspaceTopology[],
  root: string,
  problems: TopologyProblems,
): void {
  const inventoryDrift = topologyInventoryDrift(topology, root);
  if (inventoryDrift.unaccounted.length === 0 && inventoryDrift.nonexistent.length === 0) return;
  const message = `workspace inventory drift: unaccounted [${inventoryDrift.unaccounted.join(", ")}], nonexistent [${inventoryDrift.nonexistent.join(", ")}]`;
  for (const consumer of CONSUMERS) problems[consumer].push(message);
}

function checkKnipInventory(
  topology: readonly WorkspaceTopology[],
  root: string,
  problems: TopologyProblems,
): void {
  const knip = json(join(root, "knip.json"));
  const knipConfig = (knip.workspaces ?? {}) as Record<string, unknown>;
  const actual = Object.keys(knipConfig).sort();
  const expected = [".", ...knipWorkspaces(topology).map((workspace) => workspace.dir)].sort();
  if (actual.join("\n") === expected.join("\n")) return;
  const message = `expected [${expected.join(", ")}], got [${actual.join(", ")}]`;
  problems.knip.push(message);
  problems["dead-exports"].push(message);
}

function checkCiTests(
  topology: readonly WorkspaceTopology[],
  root: string,
  problems: TopologyProblems,
): void {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const match = ci.match(
    / {6}# topology:test-steps:start[^\n]*\n([\s\S]*?) {6}# topology:test-steps:end/,
  );
  if (!match || match[1] !== `${ciTestSteps(topology)}\n`) {
    problems["ci-tests"].push("generated topology test-step block is missing or stale");
  }
}

function checkCoverageInventory(
  topology: readonly WorkspaceTopology[],
  root: string,
  problems: TopologyProblems,
): void {
  const baseline = json(join(root, "script/conformance/coverage-baseline.json"));
  const expected = coverageWorkspaces(topology).map((workspace) => workspace.dir).sort();
  const actual = Object.keys(baseline).sort();
  if (actual.join("\n") !== expected.join("\n")) {
    problems["coverage-ratchet"].push(
      `baseline expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    );
  }
}

export function topologyProblems(
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
  root = join(import.meta.dir, ".."),
): TopologyProblems {
  const problems = emptyProblems();
  const dirs = new Set<string>();
  const names = new Set<string>();

  for (const workspace of topology) {
    checkWorkspaceBoundary(workspace, root, problems, dirs, names);
    checkWorkspaceSources(workspace, root, problems);
    checkWorkspaceProjects(workspace, root, problems);
  }
  checkAllowedDependencies(topology, names, problems);
  checkInventory(topology, root, problems);
  checkKnipInventory(topology, root, problems);
  checkCiTests(topology, root, problems);
  checkCoverageInventory(topology, root, problems);

  if (tsconfigWorkspaces(topology).length === 0) {
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
