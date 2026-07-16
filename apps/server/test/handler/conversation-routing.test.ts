import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEngine } from "@openomni/openomni";
import type { Dispatch, Ingress } from "@openomni/protocol";
import { Bus, PendingInteractionStore, Session, Storage, WorkerRun } from "@openomni/session";
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

function normalizeDiscordReply(replyToId: string) {
  const inbound = normalizer.normalize({
    id: `inbound-${replyToId}`,
    channel_id: "dev",
    guild_id: "guild-1",
    author: { id: "owner-1", username: "Owner" },
    content: "SN-A2334",
    message_reference: { message_id: replyToId },
  });
  if (!inbound) throw new Error("expected normalized Discord reply");
  return inbound;
}

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  IngressEngine.ingest = originalIngest;
});

afterEach(() => {
  IngressEngine.ingest = originalIngest;
  Bus.reset();
  Storage.reset();
});

describe("conversation kernel routing", () => {
  it("routes a normalized PendingInteraction reply through kernel ingress exactly once", async () => {
    // Given
    const workerSession = Session.create({
      title: "worker",
      model: { providerID: "test", modelID: "test" },
    });
    await WorkerRun.create(workerSession.id, {
      runId: "run-pending-reply",
      title: "pending reply",
      prompt: "wait for owner input",
    });
    PendingInteractionStore.create({
      id: "pending-reply",
      workerRunId: "run-pending-reply",
      sessionId: workerSession.id,
      endpointId: "bot-1",
      channelId: "dev",
      correlation: { replyToMessageId: "outbound-question" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });
    const ingest = mock(async () => ingressResult("kernel accepted reply"));
    const dispatchSubmit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "server-probe",
        status: "completed",
        output: "server probe response",
      }),
    );
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler({ ...deps, dispatchRuntime: { submit: dispatchSubmit } });

    // When
    const response = await handler(normalizeDiscordReply("outbound-question"));

    // Then
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(dispatchSubmit).toHaveBeenCalledTimes(0);
    expect(response).toEqual({ text: "kernel accepted reply" });
  });

  it("routes an unmatched normalized message through kernel ingress without a server fallback", async () => {
    // Given
    const ingest = mock(async () => ingressResult("kernel resident response"));
    const dispatchSubmit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "server-fallback",
        status: "denied",
        reason: "dispatch.actor.required",
      }),
    );
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler({ ...deps, dispatchRuntime: { submit: dispatchSubmit } });

    // When
    const response = await handler(normalizeDiscordReply("no-pending-interaction"));

    // Then
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(dispatchSubmit).toHaveBeenCalledTimes(0);
    expect(response).toEqual({ text: "kernel resident response" });
  });
});
