import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DiscordNormalizer } from "@openomni/channels";
import { Operational, type Gateway, type Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createMessageHandler } from "../../src/handler/conversation";

const normalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [] });

// The gateway router instance is the one handler dep (#549 discipline, #707
// home); each test supplies its own mock ingest through the deps seam.
function handlerFor(ingest: (event: unknown) => Promise<Ingress.IngressResult>) {
  return createMessageHandler({ ingress: { ingest } });
}

function ingressResult(output: string): Ingress.IngressResult {
  return {
    mode: "direct",
    result: { output, finishReason: "stop" },
    sessionId: "resident-session",
    target: { kind: "resident" },
  };
}

function normalizeDiscordMessage(replyToId?: string) {
  const inbound = normalizer.normalize(
    {
      id: replyToId ? `inbound-${replyToId}` : "inbound-unmatched",
      channel_id: "dev",
      guild_id: "guild-1",
      author: { id: "owner-1", username: "Owner" },
      content: replyToId ? "SN-A2334" : "Start a new conversation",
      ...(replyToId ? { message_reference: { message_id: replyToId } } : {}),
    },
    "trace-test",
  );
  if (!inbound) throw new Error("expected normalized Discord message");
  return inbound;
}

beforeEach(() => {
  Bus.reset();
});

afterEach(() => {
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
    const handler = handlerFor(ingest);

    // When
    const response = await handler(normalizeDiscordMessage("outbound-question"));

    // Then
    expect(ingest).toHaveBeenCalledTimes(1);
    const correlatedEvent = receivedEvent as Gateway.DeliveredEvent;
    expect(correlatedEvent.meta?.correlation).toMatchObject({
      replyToMessageId: "outbound-question",
    });
    // #707: the event that crosses the seam is agent-less — brain material
    // (the AgentDef) is resolved behind the router, never embedded here.
    expect("agent" in correlatedEvent).toBe(false);
    expect(response).toEqual({ text: "kernel accepted reply" });
  });

  it("routes an unmatched normalized message through kernel ingress without a server fallback", async () => {
    // Given
    let receivedEvent: unknown;
    const ingest = mock(async (event: unknown) => {
      receivedEvent = event;
      return ingressResult("kernel resident response");
    });
    const handler = handlerFor(ingest);

    // When
    const response = await handler(normalizeDiscordMessage());

    // Then
    expect(ingest).toHaveBeenCalledTimes(1);
    const unmatchedEvent = receivedEvent as Gateway.DeliveredEvent;
    expect(unmatchedEvent.meta?.correlation).not.toHaveProperty("replyToMessageId");
    expect(response).toEqual({ text: "kernel resident response" });
  });

  it("retains the normal empty-output placeholder", async () => {
    // Given
    const ingest = mock(async () => ingressResult(""));
    const handler = handlerFor(ingest);

    // When
    const response = await handler(normalizeDiscordMessage());

    // Then
    expect(response).toEqual({ text: "(no response)" });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("returns no writeback only when kernel ingress explicitly drops the message", async () => {
    const ingest = mock(
      async (): Promise<Ingress.IngressResult> => ({
        kind: "dropped",
        mode: "direct",
        target: { kind: "resident" },
        reason: "Inbound principal matched the blacklist",
      }),
    );
    const handler = handlerFor(ingest);

    const response = await handler(normalizeDiscordMessage());

    expect(response).toBeNull();
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
    const unsubscribe = Bus.subscribe(Operational.Events.Error, (payload) => {
      operationalErrors.push(payload);
    });
    const handler = handlerFor(ingest);

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
