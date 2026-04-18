import { describe, expect, it } from "bun:test";
import { SystemToolProvider } from "@openomni/openomni";
import {
  createExecutionToolContext,
  resolveWorkerDbPath,
  selectRequestedTools,
} from "../../src/execution/worker-runtime";

describe("worker-runtime", () => {
  it("resolves the worker db path from server config", () => {
    const original = process.env.OPENOMNI_DB_PATH;
    delete process.env.OPENOMNI_DB_PATH;

    try {
      expect(
        resolveWorkerDbPath({
          storage: {
            dbPath: "/tmp/openomni-custom.db",
          },
        }),
      ).toBe("/tmp/openomni-custom.db");
    } finally {
      if (original === undefined) {
        delete process.env.OPENOMNI_DB_PATH;
      } else {
        process.env.OPENOMNI_DB_PATH = original;
      }
    }
  });

  it("selects requested tools by sanitized protocol names", () => {
    const availableTools = new SystemToolProvider("/workspace/openomni").listTools();

    const selected = selectRequestedTools(availableTools, [
      { name: "bash", inputSchema: { type: "object" } },
      { name: "grep_search", inputSchema: { type: "object" } },
    ]);

    expect(selected.map((tool) => tool.spec.name)).toEqual(["bash", "grep.search"]);
  });

  it("rebuilds a tool executor that enforces request permissions", async () => {
    const availableTools = new SystemToolProvider("/workspace/openomni").listTools();
    const context = createExecutionToolContext(
      {
        tools: [{ name: "bash", inputSchema: { type: "object" } }],
        permissions: { denylist: ["bash"] },
        toolConfig: { workspaceRoot: "/workspace/openomni" },
      },
      availableTools,
    );

    expect(context.tools).toHaveLength(1);
    expect(context.toolExecutor).toBeDefined();

    if (!context.toolExecutor) throw new Error("expected toolExecutor to be defined");
    const result = await context.toolExecutor({
      id: crypto.randomUUID(),
      tool: "bash",
      input: { command: "pwd" },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("denied by policy");
  });
});
