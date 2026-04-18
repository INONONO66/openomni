import { describe, test, expect } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { SqliteStorageAdapter } from "@openomni/session/src/storage/sqlite-storage";
import { Hashline } from "../../src/plan/hashline.js";
import { PLAN_TOOL_SPECS, createPlanToolExecutor } from "../../src/plan/plan-tools";

const makeCall = (tool: string, input: Record<string, unknown>): Tool.Call => ({
  id: crypto.randomUUID(),
  tool,
  input,
});

const refFor = (lines: string[], lineNumber: number) =>
  `${lineNumber}#${Hashline.computeHash(lineNumber, lines[lineNumber - 1] ?? "")}`;

describe("PLAN_TOOL_SPECS", () => {
  test("has 4 tool specs with correct structure", () => {
    expect(PLAN_TOOL_SPECS).toHaveLength(4);

    for (const spec of PLAN_TOOL_SPECS) {
      expect(spec).toHaveProperty("name");
      expect(spec).toHaveProperty("description");
      expect(spec).toHaveProperty("inputSchema");
      expect(spec).toHaveProperty("safe");
    }
  });

  test("plan_read and plan_list are safe, plan_write and plan_edit are not safe", () => {
    const read = PLAN_TOOL_SPECS.find((s) => s.name === "plan_read");
    const write = PLAN_TOOL_SPECS.find((s) => s.name === "plan_write");
    const edit = PLAN_TOOL_SPECS.find((s) => s.name === "plan_edit");
    const list = PLAN_TOOL_SPECS.find((s) => s.name === "plan_list");

    expect(read?.safe).toBe(true);
    expect(write?.safe).toBe(false);
    expect(edit?.safe).toBe(false);
    expect(list?.safe).toBe(true);
  });
});

describe("createPlanToolExecutor", () => {
  test("plan_write then plan_read returns hashline-formatted content", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const content = "# My Plan\n- Step 1\n- Step 2";

    const writeResult = await execute(makeCall("plan_write", { planId: "p1", content }));
    expect(writeResult.isError).toBeUndefined();
    expect(writeResult.output).toContain("p1");

    const readResult = await execute(makeCall("plan_read", { planId: "p1" }));
    expect(readResult.isError).toBeUndefined();
    const parsed = JSON.parse(readResult.output);
    expect(parsed.content).toContain("# My Plan");
  });

  test("plan_edit updates content via hashline refs", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

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
    expect(editResult.isError).toBeUndefined();
    expect(editResult.output).toContain("edited");

    const readResult = await execute(makeCall("plan_read", { planId: "p1" }));
    expect(readResult.output).toContain("Line TWO updated");
  });

  test("plan_read with from/to returns only the requested range", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await execute(makeCall("plan_write", { planId: "p1", content }));

    const readResult = await execute(makeCall("plan_read", { planId: "p1", from: 2, to: 3 }));
    expect(readResult.isError).toBeUndefined();
    expect(readResult.output).toContain("Line 2");
    expect(readResult.output).toContain("Line 3");
  });

  test("plan_read with from only returns from that line to end", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await execute(makeCall("plan_write", { planId: "p1", content }));

    const readResult = await execute(makeCall("plan_read", { planId: "p1", from: 4 }));
    expect(readResult.isError).toBeUndefined();
    expect(readResult.output).toContain("Line 4");
    expect(readResult.output).toContain("Line 5");
  });

  test("plan_read with to only returns from start to that line", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await execute(makeCall("plan_write", { planId: "p1", content }));

    const readResult = await execute(makeCall("plan_read", { planId: "p1", to: 2 }));
    expect(readResult.isError).toBeUndefined();
    expect(readResult.output).toContain("Line 1");
    expect(readResult.output).toContain("Line 2");
  });

  test("plan_read on nonexistent plan returns error", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const result = await execute(makeCall("plan_read", { planId: "nope" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
  });

  test("plan_edit with bad hash returns error", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

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
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const result = await execute(makeCall("plan_delete", { planId: "p1" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool");
  });

  test("plan_write rejects non-string content", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const result = await execute(makeCall("plan_write", { planId: "p1", content: 123 }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("content must be a string");
  });

  test("plan_edit rejects non-array edits", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    await execute(makeCall("plan_write", { planId: "p1", content: "line one" }));

    const result = await execute(makeCall("plan_edit", { planId: "p1", edits: "not-an-array" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("edits must be an array");
  });

  test("plan_read rejects non-string planId", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    const result = await execute(makeCall("plan_read", { planId: 42 }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("planId must be a string");
  });

  test("plan_read floors non-integer from/to", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    await execute(makeCall("plan_write", { planId: "p1", content: "A\nB\nC\nD\nE" }));
    const result = await execute(makeCall("plan_read", { planId: "p1", from: 2.7, to: 3.9 }));
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("B");
    expect(result.output).toContain("C");
  });

  test("plan_edit rejects null items in edits array", async () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    const execute = createPlanToolExecutor(Storage.get().plan!);

    await execute(makeCall("plan_write", { planId: "p1", content: "hello" }));
    const result = await execute(
      makeCall("plan_edit", { planId: "p1", edits: [null, { op: "replace" }] }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-null object");
  });
});
