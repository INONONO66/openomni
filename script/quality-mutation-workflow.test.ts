import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJson, jsonArray, jsonObject, jsonString } from "./quality-inventory";

// Workflow keys and command wiring are machine-consumed, not prose snapshots.
test("full mutation is an explicit scheduled workflow, never a silently skipped PR gate", () => {
  const parsed = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))",
    ],
    {
      stdin: readFileSync(join(import.meta.dir, "../.github/workflows/quality-mutation.yml")),
      timeout: 5000,
    },
  );
  expect(parsed.exitCode).toBe(0);
  const workflow = jsonObject(decodeJson(parsed.stdout.toString()));
  const triggers = jsonObject(workflow.on);
  expect(jsonArray(triggers.schedule, jsonObject).length).toBeGreaterThan(0);
  expect(Object.hasOwn(triggers, "workflow_dispatch")).toBe(true);
  expect(Object.hasOwn(triggers, "pull_request")).toBe(false);
  const job = jsonObject(jsonObject(workflow.jobs).mutation);
  const steps = jsonArray(job.steps, jsonObject);
  expect(
    steps.some(
      (step) =>
        typeof step.run === "string" && step.run.includes("script/quality-native-mutation.ts"),
    ),
  ).toBe(true);
  expect(
    steps.some(
      (step) => typeof step.run === "string" && step.run.includes("script/check-quality-python.ts"),
    ),
  ).toBe(true);
  for (const step of steps) {
    if (typeof step.run !== "string" || !step.run.includes("script/quality-native-mutation.ts"))
      continue;
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.if).toBeUndefined();
    expect(jsonString(step.run)).toContain("--baseline");
  }
});
