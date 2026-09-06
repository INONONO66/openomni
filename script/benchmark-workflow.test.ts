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

test("memory guards do not prevent collection artifacts or comparison", () => {
  expect(workflow.jobs.memory).toBeDefined();
  expect(workflow.jobs.publish?.needs).toBe("benchmark");
  const steps = workflow.jobs.benchmark?.steps ?? [];
  expect(steps.some((step) => step.run?.includes("memory-regression.bench.ts"))).toBe(false);
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.if).toBe("always()");
  expect(upload?.with?.["retention-days"]).toBe(14);
});
