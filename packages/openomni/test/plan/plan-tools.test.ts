import { describe, test, expect } from "bun:test";
import { Hashline, type Tool } from "@openomni/protocol";
import { InMemoryPlanStore } from "../../src/plan/plan-store";
import { PLAN_TOOL_SPECS, createPlanToolExecutor } from "../../src/plan/plan-tools";

const makeCall = (tool: string, input: Record<string, unknown>): Tool.Call => ({
  id: crypto.randomUUID(),
  tool,
  input,
});

const refFor = (lines: string[], lineNumber: number) =>
  `${lineNumber}#${Hashline.computeHash(lineNumber, lines[lineNumber - 1] ?? "")}`;

describe("PLAN_TOOL_SPECS", () => {
  test("has 3 tool specs with correct structure", () => {
    expect(PLAN_TOOL_SPECS).toHaveLength(3);

    for (const spec of PLAN_TOOL_SPECS) {
      expect(spec).toHaveProperty("name");
      expect(spec).toHaveProperty("description");
      expect(spec).toHaveProperty("inputSchema");
      expect(spec).toHaveProperty("safe");
    }
  });

  test("plan_read is safe, plan_write and plan_edit are not safe", () => {
    const read = PLAN_TOOL_SPECS.find((s) => s.name === "plan_read");
    const write = PLAN_TOOL_SPECS.find((s) => s.name === "plan_write");
    const edit = PLAN_TOOL_SPECS.find((s) => s.name === "plan_edit");

    expect(read?.safe).toBe(true);
    expect(write?.safe).toBe(false);
    expect(edit?.safe).toBe(false);
  });
});

describe("createPlanToolExecutor", () => {
  test("plan_write then plan_read returns hashline-formatted content", async () => {
    const store = new InMemoryPlanStore();
    const execute = createPlanToolExecutor(store);

    const content = "# My Plan\n- Step 1\n- Step 2";

    const writeResult = await execute(makeCall("plan_write", { planId: "p1", content }));
    expect(writeResult.isError).toBe(false);
    expect(writeResult.output).toContain("p1");
    expect(writeResult.output).toContain("3 lines");

    const readResult = await execute(makeCall("plan_read", { planId: "p1" }));
    expect(readResult.isError).toBe(false);
    expect(readResult.output).toContain("#");
    expect(readResult.output).toContain("│");
    expect(readResult.output).toContain("# My Plan");
  });

  test("plan_edit updates content via hashline refs", async () => {
    const store = new InMemoryPlanStore();
    const execute = createPlanToolExecutor(store);

    const content = "Line one\nLine two\nLine three";
    await execute(makeCall("plan_write", { planId: "p1", content }));

    const lines = content.split("\n");
    const ref = refFor(lines, 2);

    const editResult = await execute(
      makeCall("plan_edit", {
        planId: "p1",
        edits: [{ op: "replace", pos: ref, lines: ["Line TWO updated"] }],
      }),
    );
    expect(editResult.isError).toBe(false);
    expect(editResult.output).toContain("edited");

    const readResult = await execute(makeCall("plan_read", { planId: "p1" }));
    expect(readResult.output).toContain("Line TWO updated");
  });

  test("plan_read with from/to returns only the requested range", async () => {
    const store = new InMemoryPlanStore();
    const execute = createPlanToolExecutor(store);

    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await execute(makeCall("plan_write", { planId: "p1", content }));

    const readResult = await execute(makeCall("plan_read", { planId: "p1", from: 2, to: 3 }));
    expect(readResult.isError).toBe(false);

    const outputLines = readResult.output.split("\n");
    expect(outputLines).toHaveLength(2);
    expect(readResult.output).toContain("Line 2");
    expect(readResult.output).toContain("Line 3");
    expect(readResult.output).not.toContain("Line 1");
    expect(readResult.output).not.toContain("Line 4");
  });

  test("plan_read on nonexistent plan returns error", async () => {
    const store = new InMemoryPlanStore();
    const execute = createPlanToolExecutor(store);

    const result = await execute(makeCall("plan_read", { planId: "nope" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
  });

  test("plan_edit with bad hash returns error", async () => {
    const store = new InMemoryPlanStore();
    const execute = createPlanToolExecutor(store);

    const content = "Line one\nLine two";
    await execute(makeCall("plan_write", { planId: "p1", content }));

    const editResult = await execute(
      makeCall("plan_edit", {
        planId: "p1",
        edits: [{ op: "replace", pos: "2#ZZ", lines: ["bad"] }],
      }),
    );
    expect(editResult.isError).toBe(true);
    expect(editResult.output).toContain("stale ref");
  });

  test("unknown tool returns error", async () => {
    const store = new InMemoryPlanStore();
    const execute = createPlanToolExecutor(store);

    const result = await execute(makeCall("plan_delete", { planId: "p1" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool");
  });
});
