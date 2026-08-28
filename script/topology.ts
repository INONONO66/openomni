export type DependencyBand = "none" | "any-except-self" | readonly string[];

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
    key: "telemetry",
    displayName: "telemetry",
    dir: "packages/telemetry",
    packageName: "@openomni/telemetry",
    allowedDeps: ["@openomni/protocol"],
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
    allowedDeps: ["@openomni/protocol", "@openomni/telemetry"],
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
    allowedDeps: ["@openomni/protocol", "@openomni/telemetry"],
    srcAllowedDeps: ["@openomni/protocol"],
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
      "@openomni/policy",
      "@openomni/placement",
      "@openomni/llm",
      "@openomni/telemetry",
    ],
    srcAllowedDeps: [
      "@openomni/protocol",
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
      "@openomni/telemetry",
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
      "@openomni/telemetry",
      "@openomni/policy",
      "@openomni/placement",
      "@openomni/machines",
    ],
    testLane: true,
    // Apps intentionally do not participate in the package coverage ratchet.
    coverageLane: false,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
] as const satisfies readonly WorkspaceTopology[];

export const coverageWorkspaces = (topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  topology.filter((workspace) => workspace.coverageLane);

export const knipWorkspaces = (topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  topology.filter((workspace) => workspace.knipWorkspace);

export const tsconfigWorkspaces = (topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  topology.filter((workspace) => workspace.tsconfigVerify);

export function ciTestSteps(topology: readonly WorkspaceTopology[] = TOPOLOGY): string {
  return topology
    .filter((workspace) => workspace.testLane)
    .map((workspace) => {
      const command =
        workspace.ciTestCommand ??
        (workspace.coverageLane
          ? "bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage"
          : "bun test --timeout 15000");
      return `      - name: Test (${workspace.displayName})\n        run: ${command}\n        working-directory: ${workspace.dir}`;
    })
    .join("\n");
}
