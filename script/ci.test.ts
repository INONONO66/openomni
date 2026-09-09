import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { planChanges } from "./ci-plan";
import { gate } from "./ci";
import { TOPOLOGY } from "./topology";

const root = join(import.meta.dir, "..");
const QUALITY_JOBS = ["quality-static", "quality-gates", "quality"];
function cli(args: readonly string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "script/ci.ts", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "openomni-ci-"));
  for (const workspace of TOPOLOGY) {
    mkdirSync(join(dir, workspace.dir), { recursive: true });
    writeFileSync(
      join(dir, workspace.dir, "package.json"),
      JSON.stringify({
        scripts: workspace.key === "protocol" ? { build: "tsc" } : {},
      }),
    );
  }
  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}
const jobSchema = z.object({
  needs: z.array(z.string()).optional(),
  if: z.string().optional(),
  steps: z.array(
    z.object({
      run: z.string().optional(),
      if: z.string().optional(),
      uses: z.string().optional(),
      with: z
        .object({ ref: z.string().optional(), "fetch-depth": z.number().optional() })
        .optional(),
      "working-directory": z.string().optional(),
    }),
  ),
});

test("docs-only planning keeps both final statuses successful while work is intentionally skipped", () => {
  // Given a real planner decision and GitHub's skipped job results.
  const plan = planChanges(["README.md"]);
  const needs = Object.fromEntries(
    [
      "tests", "static", "deps", "desktop-smoke", "quality-static", "quality-gates", "quality",
      "dependency-review", "scripts-coverage",
    ].map((job) => [job, { result: "skipped" }]),
  );
  // When the actual CLI consumes GitHub's serialized output.
  const result = cli(["gate"], {
    CI_PLAN: JSON.stringify(plan),
    CI_NEEDS: JSON.stringify({ ...needs, plan: { result: "success" }, prepare: { result: "success" }, "scripts-contracts": { result: "success" } }),
    CI_EVENT: "pull_request",
  });
  // Then documentation is a deliberate success, not a missing required status.
  expect(result.exitCode).toBe(0);
});

for (const job of [
  "plan", "prepare", "tests", "static", "deps", "desktop-smoke", "quality-static", "quality-gates", "quality",
  "dependency-review", "scripts-contracts", "scripts-coverage",
]) {
  for (const status of ["failure", "cancelled", "skipped", "missing"]) {
    test(`final gate rejects ${job} ${status} for a required full run`, () => {
      // Given a full plan and one unsuccessful/missing required result. Quality
      // is required on pushes, so the push event exercises every job.
      const needs: Record<string, { result: string }> = Object.fromEntries(
        [
          "plan", "prepare", "tests", "static", "deps", "desktop-smoke", "quality-static", "quality-gates", "quality",
          "dependency-review", "scripts-contracts", "scripts-coverage",
        ].map((key) => [key, { result: "success" }]),
      );
      if (status === "missing") delete needs[job];
      else needs[job] = { result: status };
      // When the real final-gate entry point runs.
      const result = cli(["gate"], {
        CI_PLAN: JSON.stringify(planChanges([], true)),
        CI_NEEDS: JSON.stringify(needs),
        CI_EVENT: job === "dependency-review" ? "pull_request" : "push",
      });
      // Then matrix failure/cancellation and unexpected skips remain failures.
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(`${job}: ${status}`);
    });
  }
}

for (const path of ["README.md", "apps/desktop/src/main/index.ts", "packages/ui/src/index.ts", "packages/ledger/src/index.ts", "script/ci.ts"]) {
  test(`desktop smoke follows selected v2 lanes for ${path}`, () => {
    const plan = planChanges([path]);
    const selected = plan.matrix.include.some((lane) => lane.key === "desktopApp" || lane.key === "ui");
    const needs = {
      plan: { result: "success" }, prepare: { result: "success" },
      "scripts-contracts": { result: "success" },
      "scripts-coverage": { result: plan.toolingTests ? "success" : "skipped" },
      ...Object.fromEntries(["tests", "static", "deps"].map((job) => [job, { result: plan.verify ? "success" : "skipped" }])),
      ...Object.fromEntries(QUALITY_JOBS.map((job) => [job, { result: plan.verify ? "success" : "skipped" }])),
      "dependency-review": { result: plan.dependencyReview ? "success" : "skipped" },
    };
    for (const status of ["success", "skipped", "failure", "cancelled"]) {
      const result = cli(["gate"], {
        CI_PLAN: JSON.stringify(plan), CI_EVENT: "pull_request",
        CI_NEEDS: JSON.stringify({ ...needs, "desktop-smoke": { result: status } }),
      });
      expect(result.exitCode === 0).toBe(status === (selected ? "success" : "skipped"));
    }
  });
}

test("desktop smoke uses exact selected lane keys and joins the final gate", () => {
  const jobs = z.object({ jobs: z.record(z.string(), jobSchema) }).parse(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))).jobs;
  expect(jobs["desktop-smoke"]?.needs).toEqual(["plan", "prepare"]);
  expect(jobs["desktop-smoke"]?.if).toBe("needs.plan.outputs.verify == 'true' && (contains(fromJSON(needs.plan.outputs.matrix).include.*.key, 'desktopApp') || contains(fromJSON(needs.plan.outputs.matrix).include.*.key, 'ui'))");
  expect(jobs["desktop-smoke"]?.steps.some((step) => step.run === "xvfb-run -a bun run test:e2e")).toBe(true);
  for (const job of ["desktop-smoke", "scripts-contracts", "scripts-coverage"]) expect(jobs.ci?.needs).toContain(job);
});

test("full gate executes the required quality jobs in process", () => {
  const plan = planChanges([], true);
  const env = {
    CI_NEEDS: JSON.stringify({
      ...Object.fromEntries([
        "plan", "prepare", "tests", "static", "deps", "desktop-smoke", "quality-static", "quality-gates", "quality",
        "scripts-contracts", "scripts-coverage",
      ].map((job) => [job, { result: "success" }])),
      "dependency-review": { result: "skipped" },
    }),
    CI_EVENT: "push",
  };
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  try {
    Object.assign(process.env, env);
    expect(gate({ ...plan, matrix: { include: [...plan.matrix.include] } }, false)).toBeUndefined();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("final gate rejects absent planner output", () => {
  // Given missing output, even if GitHub reports the plan job as successful.
  const result = cli(["test-gate"], { CI_PLAN: "", CI_NEEDS: '{"plan":{"result":"success"}}' });
  // When parsing the actual boundary, then the status cannot be successful.
  expect(result.exitCode).not.toBe(0);
});

test("documentation typecheck invokes no executable workspace", () => {
  // Given the planner's executable skip decision.
  const result = cli(["check-types"], { CI_PLAN: JSON.stringify(planChanges(["README.md"])) });
  // When the canonical typecheck mode runs, then no compiler output exists.
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
});

test("typecheck rejects untrusted lane paths before spawning", () => {
  // Given a forged plan that attempts to escape the repository.
  const plan = {
    ...planChanges([], true),
    full: false,
    matrix: { include: [{ key: "protocol", dir: "../../tmp; exit 0", coverage: true }] },
  };
  // When the CLI parses it, then no raw path reaches a shell.
  expect(cli(["check-types"], { CI_PLAN: JSON.stringify(plan) }).exitCode).not.toBe(0);
});

test("artifact pack rejects a missing workspace build", () => {
  // Given manifests with a build but no produced dist.
  using sandbox = fixture();
  // When packing, then the shared artifact cannot silently omit that build.
  const result = cli(["pack", "--root", sandbox.dir]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("missing build artifact: packages/protocol/dist");
});

test("artifact restore rejects a missing download", () => {
  // Given a consumer without its uploaded archive.
  using sandbox = fixture();
  // When restoring, then tar failure propagates to CI.
  expect(cli(["restore", "--root", sandbox.dir]).exitCode).not.toBe(0);
});

test("shared artifacts preserve workspace paths and symlinks without node_modules", () => {
  // Given a real dist tree alongside installed dependencies.
  using sandbox = fixture();
  const dist = join(sandbox.dir, "packages/protocol/dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.js"), "export const protocol = true;\n");
  symlinkSync("index.js", join(dist, "alias.js"));
  mkdirSync(join(sandbox.dir, "node_modules"));
  writeFileSync(join(sandbox.dir, "node_modules/private"), "not an artifact");
  expect(cli(["pack", "--root", sandbox.dir]).exitCode).toBe(0);
  rmSync(dist, { recursive: true });
  // When another consumer extracts the real tar archive.
  const result = cli(["restore", "--root", sandbox.dir]);
  // Then the module is reachable at its original package path, including aliases.
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(dist, "alias.js"), "utf8")).toBe("export const protocol = true;\n");
  const listing = Bun.spawnSync(["tar", "-tf", join(sandbox.dir, "workspace-dist.tar")]);
  expect(listing.stdout.toString()).not.toContain("node_modules");
});

test("workflow restores the one build before every executable consumer", () => {
  // Given the shipped workflow.
  const jobs = z
    .object({ jobs: z.record(z.string(), jobSchema) })
    .parse(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))).jobs;
  // When discovering consumers, then none rebuilds or bypasses artifact validation.
  for (const name of ["tests", "static", "deps", "quality-static", "quality-gates", "quality"]) {
    expect(
      jobs[name]?.steps.some((step) => step.uses?.startsWith("actions/download-artifact@")),
    ).toBe(true);
    expect(jobs[name]?.steps.some((step) => step.run === "bun run ci restore")).toBe(true);
    expect(jobs[name]?.steps.some((step) => step.run?.includes("run build"))).toBe(false);
  }
  for (const job of Object.values(jobs)) {
    expect(job.steps[0]?.uses?.startsWith("actions/checkout@")).toBe(true);
    expect(job.steps[0]?.with?.ref).toBe(`\${{ github.sha }}`);
    expect(job.steps[0]?.with?.["fetch-depth"]).toBe(0);
  }
  expect(jobs.test?.if).toBe("always()");
  expect(jobs.ci?.if).toBe("always()");
  expect(jobs.static?.steps.some((step) => step.run?.includes("bun run lint:docs"))).toBe(true);
});

test("v2 workflow carries scope as an artifact and always runs repository contracts", () => {
  const jobs = z.object({ jobs: z.record(z.string(), jobSchema.extend({ outputs: z.record(z.string(), z.string()).optional(), "timeout-minutes": z.union([z.number(), z.string()]) })) }).parse(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))).jobs;
  expect(jobs.plan?.outputs?.class).toBeDefined();
  expect(jobs.plan?.outputs?.toolingTests).toBeDefined();
  expect(jobs.plan?.outputs?.plan).toBeUndefined();
  expect(jobs["scripts-contracts"]?.needs).toEqual(["plan", "prepare"]);
  expect(jobs["scripts-contracts"]?.if).toBeUndefined();
  expect(jobs["scripts-coverage"]?.needs).toContain("tests");
  expect(jobs["quality-static"]?.["timeout-minutes"]).toBe(20);
  expect(jobs.tests?.["timeout-minutes"]).toBe(`\${{ startsWith(matrix.key, 'scripts-tooling-') && 15 || 30 }}`);
  expect(jobs["quality-static"]?.steps.some((step) => step.run?.includes('--plan ci-plan.json'))).toBe(true);
});

test("quality collectors run beside tests and join the required final gates", () => {
  const jobs = z
    .object({ jobs: z.object({ quality: jobSchema, "quality-static": jobSchema, "quality-gates": jobSchema, ci: jobSchema }) })
    .parse(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))).jobs;
  expect(jobs.quality.needs).toContain("quality-static");
  expect(jobs.quality.needs).toContain("tests");
  expect(jobs["quality-static"].needs).toEqual(["plan", "prepare"]);
  expect(jobs["quality-static"].needs).not.toContain("tests");
  expect(jobs["quality-gates"].needs).toEqual(["plan", "prepare"]);
  expect(jobs.ci.needs).toContain("quality-static");
  expect(jobs.ci.needs).toContain("quality-gates");
});

test("quality matrix has exactly five bounded legs and no job exceeds sixty minutes", () => {
  const jobs = z
    .object({
      jobs: z.record(
        z.string(),
        jobSchema.extend({
          "timeout-minutes": z.union([z.number(), z.string()]),
          strategy: z
            .object({
              "fail-fast": z.boolean(),
              matrix: z.union([z.string(), z.object({ leg: z.array(z.string()).optional() })]),
            })
            .optional(),
        }),
      ),
    })
    .parse(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))).jobs;
  for (const [name, job] of Object.entries(jobs)) {
    const timeout = job["timeout-minutes"];
    if (typeof timeout === "number") {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(60);
    } else {
      expect(name).toBe("tests");
      expect(timeout).toBe(`\${{ startsWith(matrix.key, 'scripts-tooling-') && 15 || 30 }}`);
    }
  }
  expect(jobs["quality-static"]?.strategy).toEqual({
    "fail-fast": false,
    matrix: { leg: ["types", "publisher", "export", "store", "metrics"] },
  });
});

test("the stable Test status accepts only the planned documentation skip", () => {
  // Given the real docs plan and exactly the Test job's needs.
  const result = cli(["test-gate"], {
    CI_PLAN: JSON.stringify(planChanges(["README.md"])),
    CI_NEEDS: JSON.stringify({
      plan: { result: "success" },
      prepare: { result: "success" },
      tests: { result: "skipped" },
      "scripts-contracts": { result: "success" },
      "scripts-coverage": { result: "skipped" },
    }),
  });
  // When its CLI executes, then the always-running status succeeds.
  expect(result.exitCode).toBe(0);
});

test("a pull request requires every quality job to succeed", () => {
  const needs = Object.fromEntries(
    ["plan", "prepare", "tests", "static", "deps", "desktop-smoke", "dependency-review", "scripts-contracts", "scripts-coverage", ...QUALITY_JOBS].map((key) => [key, { result: "success" }]),
  );
  const result = cli(["gate"], {
    CI_PLAN: JSON.stringify(planChanges([], true)),
    CI_EVENT: "pull_request",
    CI_NEEDS: JSON.stringify(needs),
  });
  expect(result.exitCode).toBe(0);
});

test("quality jobs run on executable pull requests and merge groups", () => {
  const workflow = z
    .object({
      on: z.object({ merge_group: z.object({}).nullable() }),
      concurrency: z.object({ "cancel-in-progress": z.string() }),
      jobs: z.record(z.string(), jobSchema),
    })
    .parse(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")));
  // Only pull requests cancel superseded runs; merge groups and main keep every run.
  expect(workflow.concurrency["cancel-in-progress"]).toBe(["$", "{{ github.event_name == 'pull_request' }}"].join(""));
  const conditions = QUALITY_JOBS.map((q) => workflow.jobs[q]?.if);
  expect(conditions.slice(0, 2)).toEqual(["needs.plan.outputs.verify == 'true'", "needs.plan.outputs.verify == 'true'"]);
  // A skipped need (scripts-coverage on non-tooling PRs) skips a dependent job
  // unless its condition carries a status-check function; without `!cancelled()`
  // the `skipped` branch below is unreachable and the fan-in is skipped.
  expect(conditions[2]).toBe(
    "!cancelled() && needs.plan.outputs.verify == 'true' && needs.prepare.result == 'success' && needs.tests.result == 'success' && needs.scripts-contracts.result == 'success' && needs.quality-static.result == 'success' && (needs.scripts-coverage.result == 'success' || needs.scripts-coverage.result == 'skipped')",
  );
});

test("the full push gate accepts successful checks without PR-only dependency review", () => {
  // Given full main-branch results with only the PR-specific check disabled.
  const needs = Object.fromEntries(
    [
      "plan", "prepare", "tests", "static", "deps", "desktop-smoke", "quality-static", "quality-gates", "quality", "scripts-contracts", "scripts-coverage",
    ].map((key) => [key, { result: "success" }]),
  );
  // When the real gate executes, then all mandatory work is accepted.
  const result = cli(["gate"], {
    CI_PLAN: JSON.stringify(planChanges([], true)),
    CI_EVENT: "push",
    CI_NEEDS: JSON.stringify({ ...needs, "dependency-review": { result: "skipped" } }),
  });
  expect(result.exitCode).toBe(0);
});

test("restore rejects an archive that omits a declared build", () => {
  // Given a downloaded archive containing no required workspace dist.
  using sandbox = fixture();
  writeFileSync(join(sandbox.dir, "unrelated.txt"), "not a build");
  const packed = Bun.spawnSync(["tar", "-cf", "workspace-dist.tar", "unrelated.txt"], {
    cwd: sandbox.dir,
  });
  expect(packed.exitCode).toBe(0);
  // When restore runs, then merely having an artifact is insufficient.
  const result = cli(["restore", "--root", sandbox.dir]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("missing build artifact: packages/protocol/dist");
});

test("selected test lanes depend only on planning and the shared build", () => {
  // Given the real workflow, not a duplicate configuration fixture.
  const workflow = z
    .object({ jobs: z.record(z.string(), jobSchema) })
    .parse(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")));
  // When GitHub discovers the test job.
  const job = workflow.jobs.tests;
  // Then unrelated static and dependency gates cannot serialize it.
  expect(job?.needs).toEqual(["plan", "prepare"]);
  for (const lane of TOPOLOGY) {
    expect(job?.steps.find((step) => step["working-directory"] === lane.dir)?.if).toBe(
      `matrix.key == '${lane.key}'`,
    );
  }
});
