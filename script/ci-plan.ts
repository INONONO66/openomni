import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { assertTopologyComplete, TOPOLOGY, type WorkspaceTopology } from "./topology";

export interface CiPlan {
  readonly full: boolean;
  readonly verify: boolean;
  readonly dependencyReview: boolean;
  readonly matrix: { readonly include: readonly { readonly key: string; readonly dir: string; readonly coverage: boolean }[] };
  readonly reason: string;
}

export function planChanges(
  paths: readonly string[] | undefined,
  full = false,
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
): CiPlan {
  validateGraph(topology);
  if (full) return fullPlan(topology, "full-requested");
  if (paths === undefined) throw new Error("PR planning requires discovered changed paths");

  const selected = new Set<string>();
  for (const path of paths) {
    if (/^(README\.md|CONTRIBUTING\.md|docs\/[^/]+\.md)$/.test(path)) continue;
    if (/(^|\/)(package\.json|bun\.lockb?)$/.test(path)) {
      return fullPlan(topology, "dependency-manifest-change");
    }
    const owner = topology.find((workspace) => path.startsWith(`${workspace.dir}/`));
    if (!owner || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
      return fullPlan(topology, "global-or-unowned-path");
    }
    // Protocol contracts also feed repository-wide conformance gates. Keep
    // this policy conservative even for lanes with no product import edge.
    if (owner.packageName === "@openomni/protocol") {
      return fullPlan(topology, "shared-contract-change");
    }
    selected.add(owner.packageName);
  }

  // allowedDeps intentionally includes test-only edges, unlike srcAllowedDeps.
  for (const dependency of selected) {
    for (const workspace of topology) {
      const band = workspace.allowedDeps;
      if (band === "any-except-self" || (band !== "none" && band.includes(dependency))) {
        selected.add(workspace.packageName);
      }
    }
  }
  const workspaces = topology.filter((workspace) => selected.has(workspace.packageName));
  const verify = workspaces.length > 0;
  return {
    full: false,
    verify,
    dependencyReview: false,
    matrix: { include: verify ? rows(workspaces) : [] },
    reason: verify ? "workspace-impact" : paths.length === 0 ? "empty-diff" : "root-documentation-only",
  };
}

function rows(topology: readonly WorkspaceTopology[]) {
  return [
    ...topology.map(({ key, dir, coverageLane }) => ({ key, dir, coverage: coverageLane })),
    { key: "scripts", dir: "script", coverage: true },
  ];
}

function fullPlan(topology: readonly WorkspaceTopology[], reason: string): CiPlan {
  return { full: true, verify: true, dependencyReview: true, matrix: { include: rows(topology) }, reason };
}

function validateGraph(topology: readonly WorkspaceTopology[]): void {
  if (topology.length === 0) throw new Error("topology must contain workspaces");
  const names = new Set(topology.map((workspace) => workspace.packageName));
  const keys = new Set(topology.map((workspace) => workspace.key));
  const dirs = new Set(topology.map((workspace) => workspace.dir));
  if (names.size !== topology.length || keys.size !== topology.length || dirs.size !== topology.length || keys.has("scripts")) {
    throw new Error("topology workspace names, keys and directories must be unique");
  }
  for (const workspace of topology) {
    if (!/^[a-zA-Z0-9_-]+$/.test(workspace.key) || !/^(packages|apps)\/[a-zA-Z0-9_-]+$/.test(workspace.dir)) {
      throw new Error(`invalid topology workspace boundary: ${workspace.key}`);
    }
    const band = workspace.allowedDeps;
    if (band === "none" || band === "any-except-self") continue;
    for (const dependency of band) {
      if (!names.has(dependency)) throw new Error(`unknown topology dependency: ${dependency}`);
    }
  }
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { base: { type: "string" }, head: { type: "string" }, full: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  // Inventory validation must run even when a docs-only/full shortcut is used.
  assertTopologyComplete(TOPOLOGY, process.cwd());
  const event = process.env.GITHUB_EVENT_NAME;
  const full = values.full === true || (event !== undefined && event !== "" && event !== "pull_request");
  let paths: readonly string[] | undefined;
  if (!full) {
    const sha = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
    const base = sha.parse(values.base);
    const head = sha.parse(values.head);
    // Argument arrays, SHA validation, and NUL delimiters avoid shell expansion,
    // option injection, rename loss, and splitting filenames on whitespace.
    const result = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head, "--"], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`git diff failed (${result.exitCode}): ${result.stderr.toString()}`);
    const output = result.stdout.toString();
    if (output !== "" && !output.endsWith("\0")) throw new Error("git diff output is not NUL terminated");
    paths = output === "" ? [] : output.slice(0, -1).split("\0");
  }
  const plan = planChanges(paths, full);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `full=${plan.full}\nverify=${plan.verify}\ndependencyReview=${plan.dependencyReview}\nmatrix=${JSON.stringify(plan.matrix)}\n`);
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (import.meta.main) main();
