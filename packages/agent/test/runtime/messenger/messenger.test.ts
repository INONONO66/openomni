import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Messenger } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { AgentMessenger, type Transport } from "../../../src/runtime/messenger/messenger";

function envelope(fromAgentId: string, toAgentId: string): Messenger.MessageEnvelope {
  return {
    id: "env-1",
    traceId: "trace-1",
    correlationId: null,
    sessionId: "session-1",
    runId: "run-1",
    fromAgentId,
    toAgentId,
    sentAt: new Date().toISOString(),
    schemaRef: "test",
    payload: {},
    persistencePolicy: "both",
  };
}

function makeTransport(): Transport & { readonly sendMock: ReturnType<typeof mock> } {
  const sendMock = mock(async () => undefined);
  return {
    sendMock,
    send: sendMock,
    subscribe: () => () => undefined,
  };
}

afterEach(() => {
  Bus.reset();
});

describe("AgentMessenger verdict handling", () => {
  it("treats messenger authorization denial as terminal", async () => {
    const transport = makeTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });

    const error = await messenger.send(envelope("agent-x", "agent-y")).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Authorization denied");
    expect(transport.sendMock).not.toHaveBeenCalled();
  });
});
