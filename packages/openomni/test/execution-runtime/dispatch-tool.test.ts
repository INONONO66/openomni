import { describe, expect, test } from "bun:test";
import type { Command, Tool } from "@openomni/protocol";
import { AgentToolProvider } from "../../src/execution-runtime/tool/agent/provider";
import {
  createDispatchTool,
  createWorkerResidentAskDispatchTool,
  type DispatchToolRuntime,
} from "../../src/execution-runtime/tool/agent/tools/dispatch";

/** The context the executor attaches to every tool call. */
const TOOL_CONTEXT = {
  traceContext: { traceId: "trace-caller", sessionId: "session-1", runId: "run-1" },
} as const;

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

  test("public schema documents worker spawn acceptance criteria payload", () => {
    const provider = new AgentToolProvider();
    const tool = provider.listTools().find((entry) => entry.spec.name === "dispatch");
    const schema = JSON.stringify(tool?.spec.inputSchema);

    expect(schema).toContain("worker.spawn requires");
    expect(schema).toContain("acceptanceCriteria");
  });

  test("public schema exposes connector endpoint selectors", () => {
    const provider = new AgentToolProvider();
    const tool = provider.listTools().find((entry) => entry.spec.name === "dispatch");
    const schema = JSON.stringify(tool?.spec.inputSchema);

    expect(schema).toContain("endpointId");
    expect(schema).toContain("connectorInstallationId");
    expect(schema).not.toContain("executorKind");
  });

  test("executes through runtime with implicit context", async () => {
    let capturedInput: Command.Input | undefined;
    let capturedOptions: Parameters<DispatchToolRuntime["submit"]>[1] | undefined;
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
      TOOL_CONTEXT,
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

  /**
   * A dispatch belongs to the run that submitted it. Without this the runtime
   * mints a fresh trace per submit, and the command cannot be linked back to
   * the tool call that asked for it — the failure a trace exists to prevent.
   */
  test("forwards the calling run's trace to the runtime", async () => {
    let capturedOptions: Parameters<DispatchToolRuntime["submit"]>[1] | undefined;
    const tool = createDispatchTool({
      async submit(_input, options) {
        capturedOptions = options;
        return { dispatchId: "dispatch-1", status: "completed", output: "ok" };
      },
    });

    await tool.execute(
      call({ action: "resident.ask", target: { kind: "resident" }, payload: "hello" }),
      {
        traceContext: { traceId: "trace-caller", sessionId: "session-1", runId: "run-1" },
      },
    );

    expect(capturedOptions).toMatchObject({ traceId: "trace-caller" });
  });

  /**
   * The executor that normally invokes this tool refuses a traceless call
   * first, so this guards the exported `AgentToolProvider` surface, which can
   * reach `execute` without a context. It returns a tool error rather than
   * throwing: nothing was dispatched, and the run continues.
   */
  test("refuses a call that arrives without the run trace", async () => {
    let submitted = false;
    const tool = createDispatchTool({
      async submit() {
        submitted = true;
        return { dispatchId: "dispatch-1", status: "completed", output: "ok" };
      },
    });

    const response = await tool.execute(
      call({ action: "resident.ask", target: { kind: "resident" }, payload: "hello" }),
    );

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toMatchObject({
      status: "failed",
      error: "dispatch tool requires the run trace context",
    });
    expect(submitted).toBe(false);
  });

  test("passes worker endpoint selectors through runtime submission", async () => {
    let capturedInput: Command.Input | undefined;
    const tool = createDispatchTool({
      async submit(input) {
        capturedInput = input;
        return { dispatchId: "dispatch-1", status: "completed", output: "ok" };
      },
    });

    const response = await tool.execute(
      call({
        action: "worker.spawn",
        target: {
          kind: "worker",
          name: "cli-coder",
          endpointId: "endpoint:install:codex",
          connectorInstallationId: "install:codex",
        },
        payload: {
          text: "build with a connector endpoint",
          acceptanceCriteria: ["ledger connector endpoint dispatch"],
        },
      }),
      TOOL_CONTEXT,
    );

    expect(response.isError).toBeUndefined();
    expect(capturedInput).toEqual({
      action: "worker.spawn",
      target: {
        kind: "worker",
        name: "cli-coder",
        endpointId: "endpoint:install:codex",
        connectorInstallationId: "install:codex",
      },
      payload: {
        text: "build with a connector endpoint",
        acceptanceCriteria: ["ledger connector endpoint dispatch"],
      },
    });
  });

  test("rejects stale executorKind selector before runtime submission", async () => {
    let called = false;
    const tool = createDispatchTool({
      async submit() {
        called = true;
        return { dispatchId: "dispatch-1", status: "completed", output: "ok" };
      },
    });

    const response = await tool.execute(
      call({
        action: "resident.ask",
        target: { kind: "resident", executorKind: "connector_endpoint" },
        payload: "hello",
      }),
      TOOL_CONTEXT,
    );

    expect(response.isError).toBe(true);
    expect(response.output).toContain("Unrecognized key");
    expect(called).toBe(false);
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
      TOOL_CONTEXT,
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
        TOOL_CONTEXT,
      );

      expect(response.isError).toBe(true);
      expect(response.output).toContain("Unrecognized key");
      expect(called).toBe(false);
    }
  });

  test("worker dispatch exposes only awaited Resident asks", async () => {
    let calls = 0;
    const tool = createWorkerResidentAskDispatchTool({
      async submit() {
        calls += 1;
        return { dispatchId: "dispatch-1", status: "completed", output: "answer" };
      },
    });

    const allowed = await tool.execute(
      call({
        action: "resident.ask",
        target: { kind: "resident" },
        payload: "question",
        wait: true,
      }),
      TOOL_CONTEXT,
    );
    expect(allowed.isError).toBeUndefined();
    expect(calls).toBe(1);

    for (const input of [
      {
        action: "worker.spawn",
        target: { kind: "worker", name: "other" },
        payload: { text: "work", acceptanceCriteria: ["done"] },
        wait: true,
      },
      {
        action: "resident.ask",
        target: { kind: "worker", name: "other" },
        payload: "question",
        wait: true,
      },
      {
        action: "resident.ask",
        target: { kind: "resident" },
        payload: "question",
        wait: false,
      },
    ]) {
      const denied = await tool.execute(call(input), TOOL_CONTEXT);
      expect(denied.isError).toBe(true);
    }

    expect(calls).toBe(1);
  });
});
