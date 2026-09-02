import { beforeEach, describe, expect, test } from "bun:test";
import { ActorRegistry, ChannelGrantStore } from "@openomni/ledger";
import type { Gateway, Ingress } from "@openomni/protocol";
import { ChannelProviders } from "../../src/provider/registry.js";
import type { RenderPolicy } from "../../src/provider/contract.js";
import { createGatewayRouter } from "../../src/router/index.js";
import { WebSocketHandler } from "../../src/websocket.js";
import { resetStores } from "./_router-fixture.js";

const SECRET_SAMPLES = [
  "-----BEGIN PRIVATE KEY-----",
  "ghp_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789",
  "Authorization: Bearer Ab3dEf9hIjKlMn0pQrStUvWxYz012345",
  "password=CorrectHorseBatteryStaple",
  "gT7kQ2vLp9wZx4mNb8rHc3yEuJ1sVd6oXt5",
] as const;

const CONTEXTS = [
  (secret: string) => `credential: ${secret}`,
  (secret: string) => `\`${secret}\``,
  (secret: string) => `\`\`\`text\n${secret}\n\`\`\``,
  (secret: string) => `| key | value |\n| --- | --- |\n| deploy | ${secret} |`,
  (secret: string) => `[credential](https://example.invalid/deploy?token=${secret})`,
  (secret: string) => `**token=${secret}**`,
] as const;

const IDENTITY_RENDER = {
  renderMarkdown: (markdown: string) => markdown,
  messageLimit: 2000,
} as const satisfies RenderPolicy;

const RENDERERS: readonly (readonly [string, RenderPolicy])[] = [
  ...Object.values(ChannelProviders).map((provider): readonly [string, RenderPolicy] => [
    provider.id,
    provider.capabilities.render,
  ]),
  ["ws", IDENTITY_RENDER],
];

const published: Array<{ readonly name: string; readonly data: unknown }> = [];
let transmitted: string[];

function registerChannel(channel: string): void {
  ChannelGrantStore.put({
    id: `grant:${channel}`,
    surface: channel,
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "test-owner",
  });
}

function registerMessagingActors(channel: string): Gateway.SenderTargetGrant {
  ActorRegistry.registerIdentity({ id: "actor:sender", kind: "ai_agent", trustTier: "owner" });
  ActorRegistry.registerIdentity({ id: "actor:target", kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: `endpoint:${channel}`,
    actorId: "actor:target",
    channel,
    externalId: "target-1",
  });
  return {
    id: `send-grant:${channel}`,
    senderId: "actor:sender",
    targetActorId: "actor:target",
    operations: ["fire_and_forget"],
  };
}

function makeRouter(channel: string, policy: RenderPolicy, output: string) {
  const grant = registerMessagingActors(channel);
  return createGatewayRouter({
    sink: (event, data) => {
      published.push({ name: event.name, data });
    },
    deliver: async (delivery): Promise<Ingress.IngressResult> => ({
      mode: "direct",
      target: { kind: "resident" },
      sessionId: delivery.sessionId ?? "session:test",
      result: { output, finishReason: "stop" },
    }),
    renderFor: (candidate) => (candidate === channel ? policy.renderMarkdown : undefined),
    messaging: {
      deliveryRoutes: new Map([
        [
          channel,
          async (_externalId, body) => {
            transmitted.push(body);
            return {};
          },
        ],
      ]),
      grants: () => [grant],
    },
  });
}

function inbound(channel: string, id: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: `trace:${id}`,
    surface: channel,
    mode: "direct",
    payload: "show status",
    userId: "owner-1",
  };
}

beforeEach(() => {
  resetStores();
  published.length = 0;
  transmitted = [];
});

describe("#811 render and chunk invariant egress gate", () => {
  test("Given every provider renderer and secret context, When active or reactive output is returned, Then no body reaches a provider", async () => {
    let sequence = 0;
    for (const [channel, policy] of RENDERERS) {
      registerChannel(channel);
      for (const secret of SECRET_SAMPLES) {
        for (const wrap of CONTEXTS) {
          const body = wrap(secret);
          const router = makeRouter(channel, policy, body);
          const messageId = `message:${channel}:${sequence}`;
          sequence += 1;

          const active = await router.messaging.send({
            messageId,
            senderId: "actor:sender",
            target: { actorId: "actor:target", endpointId: `endpoint:${channel}` },
            operation: "fire_and_forget",
            body,
            at: 5_000_000_000_000,
            traceId: `trace:${messageId}`,
          });
          const reactive = await router.ingest(inbound(channel, `inbound:${sequence}`));

          expect(active).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
          expect(reactive).toMatchObject({
            kind: "dropped",
            reason: "secret_egress_denied",
          });
        }
      }
    }
    expect(transmitted).toEqual([]);
  });

  test("Given a credential crossing each provider chunk boundary, When output is gated, Then the unsplit body is withheld", async () => {
    let sequence = 0;
    for (const [channel, policy] of RENDERERS) {
      registerChannel(channel);
      const limit = policy.messageLimit ?? 2000;
      const secret = SECRET_SAMPLES[1];
      const body = `${"a".repeat(limit - Math.floor(secret.length / 2))}${secret}`;
      const router = makeRouter(channel, policy, body);
      const messageId = `message:boundary:${channel}`;

      const active = await router.messaging.send({
        messageId,
        senderId: "actor:sender",
        target: { actorId: "actor:target", endpointId: `endpoint:${channel}` },
        operation: "fire_and_forget",
        body,
        at: 5_000_000_000_000,
        traceId: `trace:${messageId}`,
      });
      const reactive = await router.ingest(inbound(channel, `inbound:boundary:${sequence}`));
      sequence += 1;

      expect(active).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
      expect(reactive).toMatchObject({ kind: "dropped", reason: "secret_egress_denied" });
    }
    expect(transmitted).toEqual([]);
  });

  test("Given a withheld reactive reply, When the router publishes its event, Then metadata excludes matched bytes", async () => {
    const channel = "discord";
    const secret = SECRET_SAMPLES[1];
    registerChannel(channel);
    const router = makeRouter(channel, ChannelProviders.discord.capabilities.render, secret);

    await router.ingest(inbound(channel, "inbound:event"));

    const event = published.find(({ name }) => name === "messaging.egress_withheld");
    expect(event?.data).toMatchObject({
      traceId: "trace:inbound:event",
      surfaceKey: "discord::",
      channel,
      class: "provider_token",
      line: 1,
    });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  test("Given a WebSocket handler error containing a credential, When framed, Then the error is fixed and secret-free", async () => {
    const secret = SECRET_SAMPLES[1];
    const handler = new WebSocketHandler(
      async () => {
        throw new Error(`upstream echoed ${secret}`);
      },
      () => undefined,
    );
    const sent: string[] = [];
    const framed = Promise.withResolvers<void>();
    const ws = {
      data: { surfaceKey: "ws::dm:c1", authenticated: true },
      send: (message: string) => {
        sent.push(message);
        framed.resolve();
      },
    };

    handler.ws.message(ws, JSON.stringify({ text: "trigger failure" }));
    await framed.promise;

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "{}")).toEqual({
      type: "error",
      message: "handler error",
      traceId: expect.any(String),
    });
    expect(sent[0]).not.toContain(secret);
  });
});
