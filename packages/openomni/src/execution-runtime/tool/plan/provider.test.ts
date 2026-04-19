import { beforeEach, describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { SqliteStorageAdapter } from "@openomni/session/src/storage/sqlite-storage";
import { PlanToolProvider } from "./provider.js";

function makeCall(tool: string, input: Record<string, unknown> = {}): Tool.Call {
  return { id: "call-1", tool, input };
}

describe("PlanToolProvider", () => {
  let provider: PlanToolProvider;

  beforeEach(() => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    provider = new PlanToolProvider();
  });

  it("has correct name and category", () => {
    expect(provider.name).toBe("plan");
    expect(provider.category).toBe("system");
  });

  it("lists 4 tools: plan_write, plan_read, plan_edit, plan_list", () => {
    const tools = provider.listTools();
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.spec.name);
    expect(names).toContain("plan_write");
    expect(names).toContain("plan_read");
    expect(names).toContain("plan_edit");
    expect(names).toContain("plan_list");
  });

  it("plan_write has riskTier 1 and plan_read/plan_list have riskTier 0", () => {
    const tools = provider.listTools();
    const write = tools.find((t) => t.spec.name === "plan_write")!;
    const read = tools.find((t) => t.spec.name === "plan_read")!;
    const list = tools.find((t) => t.spec.name === "plan_list")!;
    expect(write.riskTier).toBe(1);
    expect(read.riskTier).toBe(0);
    expect(list.riskTier).toBe(0);
  });

  it("plan_read and plan_list are read-only", () => {
    const tools = provider.listTools();
    const read = tools.find((t) => t.spec.name === "plan_read")!;
    const list = tools.find((t) => t.spec.name === "plan_list")!;
    expect(read.isReadOnly).toBe(true);
    expect(list.isReadOnly).toBe(true);
  });

  it("execute returns error for unknown tool", async () => {
    const result = await provider.execute(makeCall("plan_unknown"));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: plan_unknown");
  });

  describe("plan_write", () => {
    it("writes a plan and returns success", async () => {
      const result = await provider.execute(
        makeCall("plan_write", { planId: "plan-1", content: "# My Plan" }),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe("plan-1");
    });

    it("returns error when planId is missing", async () => {
      const result = await provider.execute(makeCall("plan_write", { content: "# Plan" }));
      expect(result.isError).toBe(true);
    });

    it("returns error when content is missing", async () => {
      const result = await provider.execute(makeCall("plan_write", { planId: "plan-1" }));
      expect(result.isError).toBe(true);
    });
  });

  describe("plan_read", () => {
    it("returns plan content after writing", async () => {
      await provider.execute(makeCall("plan_write", { planId: "plan-2", content: "# Step 1" }));

      const result = await provider.execute(makeCall("plan_read", { planId: "plan-2" }));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.content).toContain("# Step 1");
      expect(parsed.version).toBe(1);
    });

    it("returns error for missing plan", async () => {
      const result = await provider.execute(makeCall("plan_read", { planId: "nonexistent" }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });
  });

  describe("plan_list", () => {
    it("returns empty array when no plans exist", async () => {
      const result = await provider.execute(makeCall("plan_list"));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed).toEqual([]);
    });

    it("returns list of plans after writing", async () => {
      await provider.execute(makeCall("plan_write", { planId: "plan-a", content: "Plan A" }));
      await provider.execute(makeCall("plan_write", { planId: "plan-b", content: "Plan B" }));

      const result = await provider.execute(makeCall("plan_list"));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed).toHaveLength(2);
      const ids = parsed.map((p: { id: string }) => p.id);
      expect(ids).toContain("plan-a");
      expect(ids).toContain("plan-b");
    });

    it("list entries do not include content", async () => {
      await provider.execute(
        makeCall("plan_write", { planId: "plan-c", content: "secret content" }),
      );

      const result = await provider.execute(makeCall("plan_list"));
      const parsed = JSON.parse(result.output);
      expect(parsed[0].content).toBeUndefined();
      expect(parsed[0].id).toBe("plan-c");
      expect(parsed[0].version).toBeDefined();
    });
  });
});
