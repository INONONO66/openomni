import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEngine } from "@openomni/openomni";
import { Operational, type Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { DiscordNormalizer } from "../../src/channel/discord/normalizer";
import { createMessageHandler } from "../../src/handler/conversation";

const provider = { listTools: () => [] };
const deps = {
  systemProvider: provider,
  agentProvider: provider,
  mcpProvider: provider,
  customProvider: provider,
  defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  workspaceRoot: "/workspace",
};
const normalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [] });
const originalIngest = IngressEngine.ingest;

function ingressResult(output: string): Ingress.IngressResult {
  return {
    mode: "direct",
    result: { output, finishReason: "stop" },
    sessionId: "resident-session",
    target: { kind: "resident" },
  };
}

function normalizeDiscordMessage(replyToId?: string) {
  const inbound = normalizer.normalize({
    id: replyToId ? `inbound-${replyToId}` : "inbound-unmatched",
    channel_id: "dev",
    guild_id: "guild-1",
    author: { id: "owner-1", username: "Owner" },
    content: replyToId ? "SN-A2334" : "Start a new conversation",
    ...(replyToId ? { message_reference: { message_id: replyToId } } : {}),
  });
  if (!inbound) throw new Error("expected normalized Discord message");
  return inbound;
}

beforeEach(() => {
  Bus.reset();
  IngressEngine.ingest = originalIngest;
});

afterEach(() => {
  IngressEngine.ingest = originalIngest;
  Bus.reset();
});

describe("conversation kernel routing", () => {
  it("routes a normalized correlated reply through kernel ingress exactly once", async () => {
    // Given
    let receivedEvent: unknown;
    const ingest = mock(async (event: unknown) => {
      receivedEvent = event;
      return ingressResult("kernel accepted reply");
    });
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(normalizeDiscordMessage("outbound-question"));

    // Then
    expect(ingest).toHaveBeenCalledTimes(1);
    const correlatedEvent = receivedEvent as Ingress.DirectEvent;
    expect(correlatedEvent.meta?.correlation).toMatchObject({
      replyToMessageId: "outbound-question",
    });
    expect(response).toEqual({ text: "kernel accepted reply" });
  });

  it("routes an unmatched normalized message through kernel ingress without a server fallback", async () => {
    // Given
    let receivedEvent: unknown;
    const ingest = mock(async (event: unknown) => {
      receivedEvent = event;
      return ingressResult("kernel resident response");
    });
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(normalizeDiscordMessage());

    // Then
    expect(ingest).toHaveBeenCalledTimes(1);
    const unmatchedEvent = receivedEvent as Ingress.DirectEvent;
    expect(unmatchedEvent.meta?.correlation).not.toHaveProperty("replyToMessageId");
    expect(response).toEqual({ text: "kernel resident response" });
  });

  it("returns the public no-response text when kernel ingress produces empty output", async () => {
    // Given
    const ingest = mock(async () => ingressResult(""));
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(normalizeDiscordMessage());

    // Then
    expect(response).toEqual({ text: "(no response)" });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("publishes one operational error and returns its message when kernel ingress throws", async () => {
    // Given
    const ingest = mock(async () => {
      throw new Error("kernel route failed");
    });
    const operationalErrors: Array<{
      component: string;
      msg: string;
      context?: Record<string, unknown>;
    }> = [];
    const unsubscribe = Bus.subscribe(Operational.Error, (payload) => {
      operationalErrors.push(payload);
    });
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

    try {
      // When
      const response = await handler(normalizeDiscordMessage());
      await Promise.resolve();

      // Then
      expect(response).toEqual({ text: "Error: kernel route failed" });
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(operationalErrors).toHaveLength(1);
      expect(operationalErrors[0]).toMatchObject({
        component: "server",
        msg: "ingress error",
        context: { msg: "kernel route failed" },
      });
    } finally {
      unsubscribe();
    }
  });
});
