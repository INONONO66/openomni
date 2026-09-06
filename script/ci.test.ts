import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { planChanges } from "./ci-plan";
import { TOPOLOGY } from "./topology";

const root = join(import.meta.dir, "..");
function cli(args: readonly string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "script/ci.ts", ...args], {
    cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "openomni-ci-"));
  for (const workspace of TOPOLOGY) {
    mkdirSync(join(dir, workspace.dir), { recursive: true });
    writeFileSync(join(dir, workspace.dir, "package.json"), JSON.stringify({
      scripts: workspace.key === "protocol" ? { build: "tsc" } : {},
    }));
  }
  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}
const jobSchema = z.object({
  needs: z.array(z.string()).optional(),
  if: z.string().optional(),
  steps: z.array(z.object({
    run: z.string().optional(),
    if: z.string().optional(),
    uses: z.string().optional(),
    with: z.looseObject({ ref: z.string().optional(), "fetch-depth": z.number().optional() }).optional(),
    "working-directory": z.string().optional(),
  })),
});

test("docs-only planning keeps both final statuses successful while work is intentionally skipped", () => {
  // Given a real planner decision and GitHub's skipped job results.
  const plan = planChanges(["README.md"]);
  const needs = Object.fromEntries(["prepare", "tests", "static", "deps", "quality", "dependency-review"]
    .map((job) => [job, { result: "skipped" }]));
  // When the actual CLI consumes GitHub's serialized output.
  const result = cli(["gate"], { CI_PLAN: JSON.stringify(plan),
    CI_NEEDS: JSON.stringify({ ...needs, plan: { result: "success" } }), CI_EVENT: "pull_request" });
  // Then documentation is a deliberate success, not a missing required status.
  expect(result.exitCode).toBe(0);
});

for (const job of ["plan", "prepare", "tests", "static", "deps", "quality", "dependency-review"]) {
  for (const status of ["failure", "cancelled", "skipped", "missing"]) {
    test(`final gate rejects ${job} ${status} for a required full run`, () => {
      // Given a full plan and one unsuccessful/missing required result.
      const needs: Record<string, { result: string }> = Object.fromEntries(
        ["plan", "prepare", "tests", "static", "deps", "quality", "dependency-review"]
          .map((key) => [key, { result: "success" }]),
      );
      if (status === "missing") delete needs[job];
      else needs[job] = { result: status };
      // When the real final-gate entry point runs.
      const result = cli(["gate"], { CI_PLAN: JSON.stringify(planChanges([], true)),
        CI_NEEDS: JSON.stringify(needs), CI_EVENT: "pull_request" });
      // Then matrix failure/cancellation and unexpected skips remain failures.
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(`${job}: ${status}`);
    });
  }
}

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
  const plan = { ...planChanges([], true), full: false,
    matrix: { include: [{ key: "protocol", dir: "../../tmp; exit 0", coverage: true }] } };
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
  const jobs = z.object({ jobs: z.record(z.string(), jobSchema) }).parse(
    Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")),
  ).jobs;
  // When discovering consumers, then none rebuilds or bypasses artifact validation.
  for (const name of ["tests", "static", "deps", "quality"]) {
    expect(jobs[name]?.steps.some((step) => step.uses?.startsWith("actions/download-artifact@"))).toBe(true);
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

test("the stable Test status accepts only the planned documentation skip", () => {
  // Given the real docs plan and exactly the Test job's needs.
  const result = cli(["test-gate"], { CI_PLAN: JSON.stringify(planChanges(["README.md"])),
    CI_NEEDS: JSON.stringify({ plan: { result: "success" }, prepare: { result: "skipped" }, tests: { result: "skipped" } }) });
  // When its CLI executes, then the always-running status succeeds.
  expect(result.exitCode).toBe(0);
});

test("the full push gate accepts successful checks without PR-only dependency review", () => {
  // Given full main-branch results with only the PR-specific check disabled.
  const needs = Object.fromEntries(["plan", "prepare", "tests", "static", "deps", "quality"]
    .map((key) => [key, { result: "success" }]));
  // When the real gate executes, then all mandatory work is accepted.
  const result = cli(["gate"], { CI_PLAN: JSON.stringify(planChanges([], true)), CI_EVENT: "push",
    CI_NEEDS: JSON.stringify({ ...needs, "dependency-review": { result: "skipped" } }) });
  expect(result.exitCode).toBe(0);
});

test("restore rejects an archive that omits a declared build", () => {
  // Given a downloaded archive containing no required workspace dist.
  using sandbox = fixture();
  writeFileSync(join(sandbox.dir, "unrelated.txt"), "not a build");
  const packed = Bun.spawnSync(["tar", "-cf", "workspace-dist.tar", "unrelated.txt"], { cwd: sandbox.dir });
  expect(packed.exitCode).toBe(0);
  // When restore runs, then merely having an artifact is insufficient.
  const result = cli(["restore", "--root", sandbox.dir]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("missing build artifact: packages/protocol/dist");
});

test("selected test lanes depend only on planning and the shared build", () => {
  // Given the real workflow, not a duplicate configuration fixture.
  const workflow = z.object({ jobs: z.record(z.string(), jobSchema) }).parse(
    Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")),
  );
  // When GitHub discovers the test job.
  const job = workflow.jobs.tests;
  // Then unrelated static and dependency gates cannot serialize it.
  expect(job?.needs).toEqual(["plan", "prepare"]);
  for (const lane of [...TOPOLOGY, { key: "scripts", dir: "script" }]) {
    expect(job?.steps.find((step) => step["working-directory"] === lane.dir)?.if)
      .toBe(`matrix.key == '${lane.key}'`);
  }
});
