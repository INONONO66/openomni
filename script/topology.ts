import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DependencyBand = "none" | "any-except-self" | readonly string[];

export interface CoverageLane {
  readonly displayName: string;
  readonly dir: string;
  /** Workspace-relative source root owned by this lane. */
  readonly sourceRoot: "src/" | ".";
}

export interface WorkspaceTopology {
  readonly key: string;
  readonly displayName: string;
  readonly dir: string;
  readonly packageName: string;
  readonly allowedDeps: DependencyBand;
  readonly srcAllowedDeps?: readonly string[];
  /** Runs as an explicit CI test lane. */
  readonly testLane: true;
  /** Emits LCOV and must have a ratchet baseline. False is an explicit skip. */
  readonly coverageLane: boolean;
  /** Must be represented by an explicit knip workspace. */
  readonly knipWorkspace: true;
  /** Existing src/test roots and project configs are verified. */
  readonly tsconfigVerify: true;
  readonly extraSourceRoots?: readonly string[];
  readonly ciTestCommand?: string;
}

/**
 * The single structural inventory for repository workspaces. Adding a workspace
 * here makes dependency, cycle, CI, coverage, knip, and tsconfig gates account
 * for it. Package-specific source sub-bands remain in their owning gate.
 */
export const TOPOLOGY = [
  {
    key: "protocol",
    displayName: "protocol",
    dir: "packages/protocol",
    packageName: "@openomni/protocol",
    allowedDeps: "none",
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "ipc",
    displayName: "ipc",
    dir: "packages/ipc",
    packageName: "@openomni/ipc",
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "ledger",
    displayName: "ledger",
    dir: "packages/ledger",
    packageName: "@openomni/ledger",
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "policy",
    displayName: "policy",
    dir: "packages/policy",
    packageName: "@openomni/policy",
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "llm",
    displayName: "llm",
    dir: "packages/llm",
    packageName: "@openomni/llm",
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "placement",
    displayName: "placement",
    dir: "packages/placement",
    packageName: "@openomni/placement",
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "agent",
    displayName: "agent",
    dir: "packages/agent",
    packageName: "@openomni/agent",
    allowedDeps: [
      "@openomni/protocol",
      "@openomni/ledger",
      "@openomni/policy",
      "@openomni/placement",
      "@openomni/llm",
    ],
    srcAllowedDeps: [
      "@openomni/protocol",
      "@openomni/ledger",
      "@openomni/policy",
      "@openomni/placement",
      "@openomni/llm",
    ],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
    extraSourceRoots: ["bench"],
    ciTestCommand: "bun run test:ci",
  },
  {
    key: "machines",
    displayName: "machines",
    dir: "packages/machines",
    packageName: "@openomni/machines",
    allowedDeps: ["@openomni/protocol", "@openomni/ipc"],
    testLane: true,
    // Deliberate: machines has no approved baseline. CI still runs its tests,
    // while the ratchet verifies that this explicit non-coverage lane remains
    // absent from both reports and baseline until Owner-approved growth.
    coverageLane: false,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "channels",
    displayName: "channels",
    dir: "packages/channels",
    packageName: "@openomni/channels",
    allowedDeps: [
      "@openomni/protocol",
      "@openomni/policy",
      "@openomni/ledger",
    ],
    srcAllowedDeps: ["@openomni/protocol", "@openomni/policy", "@openomni/ledger"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "openomniApp",
    displayName: "openomni app",
    dir: "apps/openomni",
    packageName: "@openomni/app",
    allowedDeps: [
      "@openomni/protocol",
      "@openomni/channels",
      "@openomni/ipc",
      "@openomni/agent",
      "@openomni/llm",
      "@openomni/ledger",
      "@openomni/policy",
      "@openomni/placement",
      "@openomni/machines",
    ],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "ui",
    displayName: "ui design system",
    dir: "packages/ui",
    packageName: "@openomni/ui",
    // None, and that is the whole rule: the design system may not depend on the
    // app it dresses, nor on any kernel package. It owns tokens, primitives,
    // window chrome, the transcript's presentation, and the one `Console`
    // composition — all of it data-blind. See DESIGN.md 10.
    allowedDeps: [],
    testLane: true,
    // Deliberate: the surface's claim is visual and is reviewed through the
    // showcase shots; there is no approved line-coverage baseline yet.
    coverageLane: false,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "desktopApp",
    displayName: "desktop app",
    dir: "apps/desktop",
    packageName: "@openomni/desktop",
    // `@openomni/ui` is the renderer's design system: it renders `Console` and
    // composes primitives, and names no color of its own.
    allowedDeps: ["@openomni/protocol", "@openomni/ui"],
    testLane: true,
    // Deliberate: Electron scaffold has no approved coverage baseline yet.
    coverageLane: false,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
] as const satisfies readonly WorkspaceTopology[];

interface WorkspaceInventoryDrift {
  readonly unaccounted: readonly string[];
  readonly nonexistent: readonly string[];
}

const REPO_ROOT = join(import.meta.dir, "..");

/** Compare the topology manifest with package.json workspaces found on disk. */
export function topologyInventoryDrift(
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
  root = REPO_ROOT,
): WorkspaceInventoryDrift {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: unknown;
  };
  if (
    !Array.isArray(rootManifest.workspaces) ||
    !rootManifest.workspaces.every((workspace) => typeof workspace === "string")
  ) {
    throw new Error("root package.json workspaces must be an array of glob strings");
  }

  const actualDirs = new Set<string>();
  for (const workspaceGlob of rootManifest.workspaces) {
    for (const manifestPath of new Bun.Glob(`${workspaceGlob}/package.json`).scanSync({
      cwd: root,
      onlyFiles: true,
    })) {
      actualDirs.add(manifestPath.replace(/\/package\.json$/, ""));
    }
  }

  const topologyDirs = new Set(topology.map((workspace) => workspace.dir));
  return {
    unaccounted: [...actualDirs].filter((dir) => !topologyDirs.has(dir)).sort(),
    nonexistent: [...topologyDirs].filter((dir) => !actualDirs.has(dir)).sort(),
  };
}

/** Fail a direct topology consumer before it can scan a reduced repository. */
export function assertTopologyComplete(
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
  root = REPO_ROOT,
): void {
  const { unaccounted, nonexistent } = topologyInventoryDrift(topology, root);
  if (unaccounted.length > 0) {
    throw new Error(`topology omits on-disk workspace(s): ${unaccounted.join(", ")}`);
  }
  if (nonexistent.length > 0) {
    throw new Error(
      `topology names workspace(s) with no on-disk package: ${nonexistent.join(", ")}`,
    );
  }
}

const SCRIPT_COVERAGE_LANE: CoverageLane = {
  displayName: "scripts",
  dir: "script",
  sourceRoot: ".",
};

export const coverageLanes = (
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
): readonly CoverageLane[] => [
  ...topology
    .filter((workspace) => workspace.coverageLane)
    .map(({ displayName, dir }) => ({ displayName, dir, sourceRoot: "src/" as const })),
  SCRIPT_COVERAGE_LANE,
];

export const knipWorkspaces = (topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  topology.filter((workspace) => workspace.knipWorkspace);

export const tsconfigWorkspaces = (topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  topology.filter((workspace) => workspace.tsconfigVerify);

export function ciTestSteps(topology: readonly WorkspaceTopology[] = TOPOLOGY): string {
  const workspaceSteps = topology
    .filter((workspace) => workspace.testLane)
    .map((workspace) => ({
      command:
        workspace.ciTestCommand ??
        (workspace.coverageLane
          ? "bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage"
          : "bun test --timeout 15000"),
      dir: workspace.dir,
      displayName: workspace.displayName,
    }));
  const scriptStep = {
    command: "bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage",
    dir: SCRIPT_COVERAGE_LANE.dir,
    displayName: SCRIPT_COVERAGE_LANE.displayName,
  };

  return [...workspaceSteps, scriptStep]
    .map(
      ({ command, dir, displayName }) =>
        `      - name: Test (${displayName})\n        run: ${command}\n        working-directory: ${dir}`,
    )
    .join("\n");
}
