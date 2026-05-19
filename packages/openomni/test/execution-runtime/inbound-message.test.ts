import { describe, expect, test } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { AgentToolProvider } from "../../src/execution-runtime/tool/agent/provider";
import { createInboundMessageTool } from "../../src/execution-runtime/tool/agent/tools/inbound-message";

function result(output: string): Ingress.IngressResult {
  return {
    mode: "direct",
    target: { kind: "worker", sessionId: "worker-session" },
    sessionId: "worker-session",
    result: { output, finishReason: "stop" },
  };
}

describe("inbound_message tool", () => {
  test("wait:false returns immediately after sending through ingress", async () => {
    const events: Ingress.InboundEvent[] = [];
    const tool = createInboundMessageTool({
      ingest: async (event) => {
        events.push(event);
        return result("accepted");
      },
    });

    const response = await tool.execute({
      id: "call-async",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        action: "send",
        payload: "continue",
        wait: false,
        sessionId: "caller-session",
        agentName: "resident",
        runId: "run-1",
      },
    });

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({ status: "sent", messageId: events[0]?.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mode: "direct",
      payload: "continue",
      target: { kind: "worker", sessionId: "worker-session" },
      meta: {
        action: "send",
        depth: 1,
        actor: { role: "resident", sessionId: "caller-session", agentName: "resident" },
      },
    });
  });

  test("wait:true returns delivered output from ingress", async () => {
    const tool = createInboundMessageTool({
      ingest: async () => result("done"),
    });

    const response = await tool.execute({
      id: "call-sync",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "finish",
        wait: true,
        sessionId: "caller-session",
        agentName: "worker",
      },
    });

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "delivered",
      messageId: expect.any(String),
      output: "done",
    });
  });

  test("wait:true times out when ingress does not resolve", async () => {
    const tool = createInboundMessageTool({
      ingest: () => new Promise(() => undefined),
    });

    const response = await tool.execute({
      id: "call-timeout",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "finish",
        wait: true,
        timeoutMs: 1,
        sessionId: "caller-session",
        agentName: "worker",
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toEqual({
      status: "error",
      messageId: expect.any(String),
      error: "inbound_message timed out after 1ms",
      timedOut: true,
    });
  });

  test("rejects calls beyond the depth limit before ingress", async () => {
    let called = false;
    const tool = createInboundMessageTool({
      ingest: async () => {
        called = true;
        return result("should not happen");
      },
    });

    const response = await tool.execute({
      id: "call-depth",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        payload: "loop",
        depth: 11,
      },
    });

    expect(response.isError).toBe(true);
    expect(response.output).toContain("depth limit exceeded");
    expect(called).toBe(false);
  });

  test("authority-denied ingress errors return error-shaped tool results", async () => {
    const tool = createInboundMessageTool({
      ingest: async () => {
        throw new Error("actor is not authorized to create top-level inbound work");
      },
    });

    const response = await tool.execute({
      id: "call-denied",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        payload: "spawn work",
        wait: true,
        sessionId: "caller-session",
        agentName: "worker",
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toEqual({
      status: "error",
      messageId: expect.any(String),
      error: "actor is not authorized to create top-level inbound work",
    });
  });

  test("AgentToolProvider registers inbound_message for agent callers", () => {
    const provider = new AgentToolProvider({ ingressEngine: { ingest: async () => result("ok") } });

    expect(provider.listTools().some((tool) => tool.spec.name === "inbound_message")).toBe(true);
  });

  test("uses caller context when the executor supplies implicit inputs", async () => {
    const events: Ingress.InboundEvent[] = [];
    const provider = new AgentToolProvider({
      ingressEngine: {
        ingest: async (event) => {
          events.push(event);
          return result("ok");
        },
      },
    });

    const response = await provider.execute({
      id: "call-provider",
      tool: "inbound_message",
      input: {
        target: { kind: "resident", agentName: "main" },
        payload: "status",
        sessionId: "caller-session",
        agentName: "resident",
        runId: "run-provider",
      },
    });

    expect(response.isError).toBeUndefined();
    expect(events[0]?.meta?.actor).toMatchObject({
      role: "resident",
      sessionId: "caller-session",
      agentName: "resident",
    });
  });
});
