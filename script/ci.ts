import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { TOPOLOGY } from "./topology";

const ROOT = join(import.meta.dir, "..");
const LANES = [
  ...TOPOLOGY.map((workspace) => ({
    key: workspace.key,
    dir: workspace.dir,
    coverage: workspace.coverageLane,
  })),
  { key: "scripts", dir: "script", coverage: true },
];
const planSchema = z
  .object({
    full: z.boolean(),
    verify: z.boolean(),
    dependencyReview: z.boolean(),
    reason: z.string(),
    matrix: z.object({
      include: z.array(
        z.object({
          key: z.string(),
          dir: z.string(),
          coverage: z.boolean(),
        }),
      ),
    }),
  })
  .superRefine((plan, ctx) => {
    const keys = new Set(plan.matrix.include.map((lane) => lane.key));
    if (
      keys.size !== plan.matrix.include.length ||
      plan.verify !== keys.size > 0 ||
      (plan.full && keys.size !== LANES.length) ||
      plan.matrix.include.some(
        (lane) =>
          !LANES.some(
            (known) =>
              known.key === lane.key && known.dir === lane.dir && known.coverage === lane.coverage,
          ),
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid CI lane inventory" });
    }
  });

class CiError extends Error {
  constructor(readonly operation: string) {
    super(`CI failed: ${operation}`);
  }
}

function run(command: readonly string[], cwd = ROOT): void {
  const args =
    command[0] === "bunx"
      ? [process.execPath, "x", ...command.slice(1)]
      : command[0] === "bun"
        ? [process.execPath, ...command.slice(1)]
        : [...command];
  const child = Bun.spawnSync(args, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) throw new CiError(command.join(" "));
}

function readPlan(path?: string) {
  return planSchema.parse(
    JSON.parse(path ? readFileSync(path, "utf8") : (process.env.CI_PLAN ?? "null")),
  );
}

function gate(plan: z.infer<typeof planSchema>, testOnly: boolean): void {
  const needs = z
    .record(
      z.string(),
      z.object({
        result: z.enum(["success", "failure", "cancelled", "skipped"]),
      }),
    )
    .parse(JSON.parse(process.env.CI_NEEDS ?? "null"));
  const required = new Map([
    ["plan", true],
    ["prepare", plan.verify],
    ["tests", plan.verify],
    ...(testOnly
      ? []
      : ([
          ["static", plan.verify],
          ["deps", plan.verify],
          ["quality", plan.verify],
          ["dependency-review", plan.dependencyReview && process.env.CI_EVENT === "pull_request"],
        ] satisfies [string, boolean][])),
  ]);
  for (const [job, enabled] of required) {
    const result = needs[job]?.result;
    if (result !== (enabled ? "success" : "skipped"))
      throw new CiError(`${job}: ${result ?? "missing"}`);
  }
}

function artifacts(mode: "pack" | "restore", root: string): void {
  const archive = join(root, "workspace-dist.tar");
  if (mode === "restore") run(["tar", "-xf", archive], root);
  const dirs = TOPOLOGY.filter((workspace) => {
    const manifest = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(join(root, workspace.dir, "package.json"), "utf8")));
    return Boolean(manifest.scripts.build);
  }).map((workspace) => `${workspace.dir}/dist`);
  for (const dir of dirs) {
    if (
      !existsSync(join(root, dir)) ||
      [...new Bun.Glob("**/*").scanSync({ cwd: join(root, dir), onlyFiles: true })].length === 0
    ) {
      throw new CiError(`missing build artifact: ${dir}`);
    }
  }
  if (mode === "pack") run(["tar", "-cf", archive, ...dirs], root);
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      plan: { type: "string" },
      lane: { type: "string" },
      root: { type: "string" },
    },
  });
  switch (positionals[0]) {
    case "build":
      run(["bun", "run", "build"]);
      return;
    case "pack":
    case "restore":
      artifacts(positionals[0], values.root ?? ROOT);
      return;
    case "gate":
    case "test-gate":
      gate(readPlan(values.plan), positionals[0] === "test-gate");
      return;
    case "check-types": {
      const plan = readPlan(values.plan);
      const selected = new Set(plan.matrix.include.map((lane) => lane.key));
      const filters = TOPOLOGY.filter((workspace) => selected.has(workspace.key)).map(
        (workspace) => `--filter=${workspace.packageName}`,
      );
      // Artifacts are already restored: --only prevents dependency builds from running again.
      if (filters.length > 0) run(["bunx", "turbo", "run", "check-types", "--only", ...filters]);
      if (selected.has("scripts")) run(["bunx", "tsc", "-p", "script/tsconfig.json"]);
      return;
    }
    case "test": {
      const lane = LANES.find((candidate) => candidate.key === values.lane);
      if (!lane) throw new CiError(`unknown lane: ${values.lane}`);
      const workspace = TOPOLOGY.find((candidate) => candidate.key === lane.key);
      const override =
        workspace && "ciTestCommand" in workspace ? workspace.ciTestCommand : undefined;
      run(
        override
          ? override.split(" ")
          : [
              "bun",
              "test",
              "--timeout",
              "15000",
              ...(lane.coverage
                ? ["--coverage", "--coverage-reporter=lcov", "--coverage-dir=coverage"]
                : []),
            ],
        join(ROOT, lane.dir),
      );
      if (lane.coverage)
        run(["bun", "run", "script/check-coverage-ratchet.ts", "--lane", lane.dir]);
      return;
    }
    default:
      throw new CiError(
        "expected build, pack, restore, check-types --plan FILE, test --lane KEY, gate or test-gate",
      );
  }
}

if (import.meta.main) main();
