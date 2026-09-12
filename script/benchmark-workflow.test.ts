import { YAML } from "bun";
import { expect, test } from "bun:test";
import { z } from "zod";

const Step = z.object({
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  with: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
});
const Workflow = z.object({
  on: z.object({
    push: z.object({ branches: z.array(z.string()), paths: z.array(z.string()).optional() }),
    pull_request: z.object({ paths: z.array(z.string()) }),
    schedule: z.array(z.object({ cron: z.string() })),
  }),
  jobs: z.record(
    z.string(),
    z.object({
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      steps: z.array(Step),
    }),
  ),
});
const workflow = Workflow.parse(
  YAML.parse(await Bun.file(new URL("../.github/workflows/benchmark.yml", import.meta.url)).text()),
);

test("benchmark PRs select benchmark inputs while main and schedules stay full", () => {
  expect(workflow.on.push).toEqual({ branches: ["main"] });
  expect(workflow.on.schedule.length).toBeGreaterThan(0);
  expect(workflow.on.pull_request.paths).toEqual([
    "packages/ledger/**", "packages/agent/**", "packages/protocol/**", "script/**",
    "package.json", "bun.lock", "bunfig.toml", "turbo.json", "tsconfig.base.json",
    ".github/workflows/benchmark.yml", ".github/actions/**",
  ]);
});

test("benchmark input is validated before collection starts", () => {
  const steps = workflow.jobs.benchmark?.steps ?? [];
  const validation = steps.findIndex((step) => step.run?.includes("--validate-input"));
  const collection = steps.findIndex((step) => step.run?.includes("seq 1"));
  expect(validation).toBeGreaterThanOrEqual(0);
  expect(collection).toBeGreaterThan(validation);
});

test("failed benchmark comparisons cannot publish a new reference", () => {
  const steps = workflow.jobs.publish?.steps ?? [];
  const comparison = steps.findIndex((step) =>
    step.uses?.startsWith("benchmark-action/github-action-benchmark@"),
  );
  expect(comparison).toBeGreaterThanOrEqual(0);
  expect(steps[comparison]?.with?.["auto-push"]).toBe(false);
  const publication = steps.findIndex((step) =>
    step.run?.includes("git push origin gh-pages:gh-pages"),
  );
  expect(publication).toBeGreaterThan(comparison);
  expect(steps[publication]?.if).toBe("success()");
});

test("PR and dispatch comparisons read accepted history without publishing", () => {
  const steps = workflow.jobs.benchmark?.steps ?? [];
  const comparison = steps.find((step) => step.run?.includes("git show FETCH_HEAD:dev/bench/data.js"));
  expect(comparison?.if).toBe("github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'");
  expect(comparison?.run).toContain("git fetch --no-tags origin gh-pages");
  expect(comparison?.run).toContain("bun run script/check-benchmark-regression.ts");
  expect(steps.some((step) => step.run?.includes("git push"))).toBe(false);
  expect(steps.findIndex((step) => step === comparison)).toBeGreaterThan(
    steps.findIndex((step) => step.run === "bun run script/summarize-benchmark-runs.ts"),
  );
});

test("memory guards do not prevent collection artifacts or comparison", () => {
  expect(workflow.jobs.memory).toBeDefined();
  expect(workflow.jobs.publish?.needs).toBe("benchmark");
  const steps = workflow.jobs.benchmark?.steps ?? [];
  expect(steps.some((step) => step.run?.includes("memory-regression.bench.ts"))).toBe(false);
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.if).toBe("always()");
  expect(upload?.with?.["retention-days"]).toBe(14);
});
