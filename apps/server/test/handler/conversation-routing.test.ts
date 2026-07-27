import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ModelCatalogService } from "@openomni/llm";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import { IngressEngine } from "@openomni/openomni";
import { type Execution, Operational, type Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { DiscordNormalizer } from "../../src/channel/discord/normalizer";
import { type ConversationHandlerDeps, createMessageHandler } from "../../src/handler/conversation";

const provider = { listTools: () => [] };
const digest = "a".repeat(64);
let deps: ConversationHandlerDeps;
let secretRegistry: SecretRegistry;

function createDepsFixture(): ConversationHandlerDeps {
  secretRegistry = SecretRegistry.create(BoundarySanitizer.create());
  const { handle: credentialHandle, ref: credential } = secretRegistry.register(
    CredentialSource.parseOwner({
      providerId: "anthropic",
      credentialId: "conversation-routing",
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: { type: "api", key: "conversation-routing-test-key" },
    }),
  );
  const modelEnvironment: Execution.LLMEnvironmentV1 = {
    version: "llm-environment-v1",
    catalogSchemaVersion: 1,
    catalogSource: "bundled",
    catalogSourceVersion: "conversation-routing-v1",
    catalogDigest: digest,
    modelDigest: digest,
    endpoint: {
      version: "llm-endpoint-ref-v1",
      kind: "default",
      valueRef: "anthropic-default",
      endpointDigest: digest,
    },
    credential,
    sdkPackage: "@ai-sdk/anthropic",
    adapterVersion: "conversation-routing-v1",
    environmentDigest: digest,
  };
  const catalog = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic" as const,
      models: {
        "claude-3-haiku-20240307": {
          id: "claude-3-haiku-20240307",
          name: "Claude 3 Haiku",
          release_date: "2024-03-07",
        },
      },
    },
  };
  const modelCatalog: ModelCatalogService = {
    async load() {
      return { catalog, environment: modelEnvironment, fallbackDiagnostics: [] };
    },
    async get() {
      return catalog;
    },
  };

  return {
    systemProvider: provider,
    agentProvider: provider,
    mcpProvider: provider,
    customProvider: provider,
    defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    workspaceRoot: "/workspace",
    ownerTaskQueries: { listOpenTasks: async () => [] },
    modelCatalog,
    secretRegistry,
    credentialHandle,
    modelEnvironment,
  };
}
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
  deps = createDepsFixture();
});

afterEach(() => {
  secretRegistry.dispose();
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

  it("retains the normal empty-output placeholder", async () => {
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

  it("returns no writeback only when kernel ingress explicitly drops the message", async () => {
    const ingest = mock(
      async (): Promise<Ingress.IngressResult> => ({
        kind: "dropped",
        mode: "direct",
        target: { kind: "resident" },
        reason: "Inbound principal matched the blacklist",
      }),
    );
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

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
