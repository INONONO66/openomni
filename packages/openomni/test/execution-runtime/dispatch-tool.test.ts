import { describe, expect, test } from "bun:test";
import type { Dispatch, Tool } from "@openomni/protocol";
import { AgentToolProvider } from "../../src/execution-runtime/tool/agent/provider";
import {
  createDispatchTool,
  type DispatchToolRuntime,
} from "../../src/execution-runtime/tool/agent/tools/dispatch";

function call(input: Record<string, unknown>): Tool.Call {
  return { id: "call-1", tool: "dispatch", input };
}

describe("dispatch tool", () => {
  test("AgentToolProvider exposes dispatch", () => {
    const provider = new AgentToolProvider();
    expect(provider.listTools().some((tool) => tool.spec.name === "dispatch")).toBe(true);
  });

  test("public schema omits runtime actor/context fields", () => {
    const provider = new AgentToolProvider();
    const tool = provider.listTools().find((entry) => entry.spec.name === "dispatch");
    expect(tool).toBeDefined();
    const properties =
      (tool?.spec.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties.actor).toBeUndefined();
    expect(properties.sessionId).toBeUndefined();
    expect(properties.runId).toBeUndefined();
    expect(properties.workspaceRoot).toBeUndefined();
    expect(properties.model).toBeUndefined();
    expect(properties.provider).toBeUndefined();
    expect(properties.tools).toBeUndefined();
    expect(properties.permissions).toBeUndefined();
    expect(properties.owner).toBeUndefined();
    expect(properties.ownerId).toBeUndefined();
    expect(properties.dispatchOwners).toBeUndefined();
    expect(properties.routeOwner).toBeUndefined();
    expect(properties.resolveOwner).toBeUndefined();
  });

  test("executes through runtime with implicit context", async () => {
    let capturedInput: Dispatch.Input | undefined;
    let capturedOptions: Parameters<DispatchToolRuntime["submit"]>[1];
    const tool = createDispatchTool({
      async submit(input, options) {
        capturedInput = input;
        capturedOptions = options;
        return { dispatchId: "dispatch-1", status: "completed", output: "ok" };
      },
    });

    const response = await tool.execute(
      call({
        action: "resident.ask",
        target: { kind: "resident" },
        payload: "hello",
        wait: true,
        timeoutMs: 123,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "worker",
        workspaceRoot: "/repo",
      }),
    );

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      dispatchId: "dispatch-1",
      status: "completed",
      output: "ok",
    });
    expect(capturedInput).toEqual({
      action: "resident.ask",
      target: { kind: "resident" },
      payload: "hello",
      wait: true,
      timeoutMs: 123,
    });
    expect(capturedOptions).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      agentName: "worker",
      workspaceRoot: "/repo",
      sourceTool: "dispatch",
    });
  });

  test("rejects public actor-like fields before runtime submission", async () => {
    let called = false;
    const tool = createDispatchTool({
      async submit() {
        called = true;
        return { dispatchId: "dispatch-1", status: "completed" };
      },
    });

    const response = await tool.execute(
      call({
        action: "resident.ask",
        target: { kind: "resident" },
        payload: "hello",
        actor: { kind: "system", actorId: "fake" },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.output).toContain("Unrecognized key");
    expect(called).toBe(false);
  });

  test("rejects public owner-routing fields before runtime submission", async () => {
    for (const field of ["owner", "ownerId", "dispatchOwners", "routeOwner", "resolveOwner"]) {
      let called = false;
      const tool = createDispatchTool({
        async submit() {
          called = true;
          return { dispatchId: "dispatch-1", status: "completed" };
        },
      });

      const response = await tool.execute(
        call({
          action: "resident.ask",
          target: { kind: "resident" },
          payload: "hello",
          [field]: "fake",
        }),
      );

      expect(response.isError).toBe(true);
      expect(response.output).toContain("Unrecognized key");
      expect(called).toBe(false);
    }
  });
});
