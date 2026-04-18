import { beforeEach, describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { Storage } from "@openomni/session";
import { SqliteStorageAdapter } from "@openomni/session/src/storage/sqlite-storage";
import { createPlanToolExecutor } from "../../src/plan/plan-tools.js";

function makeCall(tool: string, input: Record<string, unknown> = {}): Tool.Call {
  return { id: "call-1", tool, input };
}

describe("createPlanToolExecutor (unified Storage.PlanSubAdapter)", () => {
  let adapter: Storage.PlanSubAdapter;
  let executor: (call: Tool.Call) => Promise<Tool.Result>;

  beforeEach(() => {
    const storage = new SqliteStorageAdapter(":memory:");
    adapter = storage.plan!;
    executor = createPlanToolExecutor(adapter);
  });

  describe("plan_write", () => {
    it("writes a plan and returns success", async () => {
      const result = await executor(
        makeCall("plan_write", { planId: "plan-1", content: "# My Plan\nStep 1" }),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe("plan-1");
    });

    it("returns error when planId is missing", async () => {
      const result = await executor(makeCall("plan_write", { content: "# Plan" }));
      expect(result.isError).toBe(true);
    });

    it("returns error when content is missing", async () => {
      const result = await executor(makeCall("plan_write", { planId: "plan-1" }));
      expect(result.isError).toBe(true);
    });
  });

  describe("plan_read", () => {
    it("reads a plan after writing (round-trip)", async () => {
      const writeResult = await executor(
        makeCall("plan_write", { planId: "plan-2", content: "# Step 1\nDetails here" }),
      );
      expect(writeResult.isError).toBeUndefined();

      const readResult = await executor(makeCall("plan_read", { planId: "plan-2" }));
      expect(readResult.isError).toBeUndefined();
      const parsed = JSON.parse(readResult.output);
      expect(parsed.content).toContain("# Step 1");
      expect(parsed.version).toBe(1);
    });

    it("returns error for non-existent plan", async () => {
      const result = await executor(makeCall("plan_read", { planId: "nonexistent" }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });

    it("reads plan with hashline format", async () => {
      await executor(
        makeCall("plan_write", { planId: "plan-3", content: "Line 1\nLine 2\nLine 3" }),
      );

      const result = await executor(makeCall("plan_read", { planId: "plan-3" }));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.content).toContain("#");
      expect(parsed.content).toContain("│");
    });

    it("reads plan with range (from/to)", async () => {
      await executor(
        makeCall("plan_write", {
          planId: "plan-4",
          content: "Line 1\nLine 2\nLine 3\nLine 4",
        }),
      );

      const result = await executor(makeCall("plan_read", { planId: "plan-4", from: 2, to: 3 }));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.content).toContain("Line 2");
      expect(parsed.content).toContain("Line 3");
    });
  });

  describe("plan_edit", () => {
    it("edits a plan using hashline refs", async () => {
      await executor(
        makeCall("plan_write", { planId: "plan-5", content: "Original line 1\nOriginal line 2" }),
      );

      const readResult = await executor(makeCall("plan_read", { planId: "plan-5" }));
      const parsed = JSON.parse(readResult.output);
      const lines = parsed.content.split("\n");
      const firstLineRef = lines[0].split("│")[0].trim();

      const editResult = await executor(
        makeCall("plan_edit", {
          planId: "plan-5",
          edits: [{ op: "replace", pos: firstLineRef, lines: ["Updated line 1"] }],
        }),
      );
      expect(editResult.isError).toBeUndefined();
    });

    it("returns error for invalid hashline ref", async () => {
      await executor(makeCall("plan_write", { planId: "plan-6", content: "Some content" }));

      const result = await executor(
        makeCall("plan_edit", {
          planId: "plan-6",
          edits: [{ op: "replace", pos: "999#ZZZZ", lines: ["New"] }],
        }),
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when edits is not an array", async () => {
      await executor(makeCall("plan_write", { planId: "plan-7", content: "Content" }));

      const result = await executor(
        makeCall("plan_edit", { planId: "plan-7", edits: "not an array" }),
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("plan_list", () => {
    it("returns empty array when no plans exist", async () => {
      const result = await executor(makeCall("plan_list"));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed).toEqual([]);
    });

    it("returns list of plans after writing", async () => {
      await executor(makeCall("plan_write", { planId: "plan-a", content: "Plan A" }));
      await executor(makeCall("plan_write", { planId: "plan-b", content: "Plan B" }));

      const result = await executor(makeCall("plan_list"));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed).toHaveLength(2);
      const ids = parsed.map((p: { id: string }) => p.id);
      expect(ids).toContain("plan-a");
      expect(ids).toContain("plan-b");
    });

    it("list entries include version and timestamps but not content", async () => {
      await executor(makeCall("plan_write", { planId: "plan-c", content: "Secret content" }));

      const result = await executor(makeCall("plan_list"));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed).toHaveLength(1);
      const entry = parsed[0];
      expect(entry.id).toBe("plan-c");
      expect(entry.version).toBeDefined();
      expect(entry.createdAt).toBeDefined();
      expect(entry.updatedAt).toBeDefined();
      expect(entry.content).toBeUndefined();
    });
  });

  describe("unknown tool", () => {
    it("returns error for unknown tool name", async () => {
      const result = await executor(makeCall("plan_unknown"));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Unknown tool");
    });
  });
});
