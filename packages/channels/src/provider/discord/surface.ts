import { newTraceId } from "../../support/trace";
import { type Channel, Operational, PolicyDecision } from "@openomni/protocol";
import { Dedupe, DedupeWindow } from "../../support/dedupe";
import { type DeliveryReceipt, deliverKeyed } from "../../support/deliver";
import { respondUnderTyping } from "../../support/handler-frame";
import { DiscordClient } from "./client";
import { DiscordHandlerMissingError } from "./error";
import { DiscordGateway } from "./gateway";
import { DiscordNormalizer } from "./normalizer";
import { type DiscordMessage, DiscordMessageSchema } from "./types";
import type { PublishPort } from "../../types";
import {
  ChannelAuthnMiddleware,
  type ChannelAuthnDecisionObserver,
  decisionOption,
} from "../../channel-authn";

interface DiscordAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

export class DiscordAdapter implements Channel.Surface {
  readonly id = "discord";

  private readonly client: DiscordClient;
  private readonly gateway: DiscordGateway;
  private readonly dedupe = new Dedupe();
  private readonly outboundDedupe = new DedupeWindow<DeliveryReceipt>();
  private normalizer: DiscordNormalizer | null = null;
  private botId: string | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly authOptions: DiscordAuthOptions = {},
  ) {
    this.client = new DiscordClient(token, publish);
    this.gateway = new DiscordGateway(
      token,
      () => this.client.fetchGatewayUrl(),
      {
        onReady: ({ botId, botUsername }) => {
          this.botId = botId;
          this.normalizer = new DiscordNormalizer({
            botId,
            triggers: this.config.triggers,
          });
          this.publish(Operational.Events.Info, {
            // Origin: a gateway READY is a distinct occurrence (initial connect
            // AND every re-identify) — deliberately its own trace, not the boot's.
            traceId: newTraceId(),
            time: Date.now(),
            component: "server",
            msg: "discord bot started",
            context: { username: botUsername, botId },
          });
        },
        onDispatch: (event, data, traceId) => {
          if (event !== "MESSAGE_CREATE") return;
          const message = DiscordMessageSchema.safeParse(data);
          if (!message.success) {
            this.publish(Operational.Events.Warn, {
              traceId,
              time: Date.now(),
              component: "server",
              msg: "discord MESSAGE_CREATE payload malformed; dropped",
            });
            return;
          }
          this.handleMessageCreate(message.data, traceId);
        },
      },
      publish,
    );
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(_traceId: string): Promise<void> {
    if (!this.handler) {
      throw new DiscordHandlerMissingError({
        message: "[discord] No message handler registered. Call onMessage() before start().",
      });
    }
    await this.gateway.start();
  }

  stop(traceId: string): void {
    this.gateway.stop();
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "discord bot stopped",
    });
  }

  /**
   * Existing-agent delivery: a registered ActorEndpoint's externalId is a
   * Discord user id — deliver by DM and report the platform message id of
   * the final chunk (the message a reply would reference).
   */
  deliver(externalId: string, body: string, idempotencyKey?: string): Promise<DeliveryReceipt> {
    return deliverKeyed(this.outboundDedupe, idempotencyKey, async (traceId) => {
      const channelId = await this.client.createDmChannel(externalId, traceId);
      return await sendDiscordMessage(this.client, channelId, { text: body }, traceId);
    });
  }

  private handleMessageCreate(message: DiscordMessage, traceId: string): void {
    if (!this.normalizer) return;
    const acquisition = this.dedupe.acquire(message.id);
    if (acquisition.duplicate) return;
    const dedupeToken = acquisition.token;
    if (message.author.bot) return;
    if (!message.content) return;

    const isDM = !message.guild_id;
    const botId = this.botId;
    if (!botId) return;

    const mentioned = message.mentions?.some((u) => u.id === botId) ?? false;
    if (this.triggerBlocks(message, isDM, mentioned)) return;

    const inbound = this.normalizer.normalize(message, traceId);
    if (!inbound) return;

    this.handleIncoming(inbound, message.channel_id, traceId).catch((err) => {
      this.dedupe.forget(message.id, dedupeToken);
      this.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "discord message handling failed",
        context: { err: String(err) },
      });
    });
  }

  private triggerBlocks(message: DiscordMessage, isDM: boolean, mentioned: boolean): boolean {
    const auth = ChannelAuthnMiddleware.authenticateDiscordTriggers({
      triggers: this.config.triggers,
      ctx: {
        event: "message",
        mentioned,
        channelId: message.channel_id,
        senderId: message.author.id,
        isDM,
        text: message.content,
      },
      ...decisionOption(this.authOptions.onDecision),
    });
    return PolicyDecision.isBlocking(auth.verdict);
  }

  private async handleIncoming(
    inbound: Channel.InboundMessage,
    channelId: string,
    traceId: string,
  ): Promise<void> {
    this.publish(Operational.Events.Debug, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "discord message received",
      context: { channelId },
    });

    await respondUnderTyping({
      typing: () => this.client.sendTyping(channelId, traceId),
      typingIntervalMs: 8000,
      run: () => (this.handler as Channel.MessageHandler)(inbound),
      send: (message) => sendDiscordMessage(this.client, channelId, message, traceId),
      onError: (err) =>
        this.publish(Operational.Events.Error, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "discord message handler error",
          context: { channelId, err },
        }),
    });
  }
}

// merged from formatter.ts (#453 hygiene: sub-30-LOC single-importer)
import { chunkMarkdown } from "../../support/format/chunk";
import { DISCORD_RENDER } from "./format";
import type { ChannelClient } from "../../types";


async function sendDiscordMessage(
  client: ChannelClient,
  channelId: string,
  message: Channel.OutboundMessage,
  traceId: string,
): Promise<string | undefined> {
  if (!message.text) return undefined;
  let lastMessageId: string | undefined;
  const rendered = DISCORD_RENDER.renderMarkdown(message.text);
  for (const chunk of chunkMarkdown(rendered, DISCORD_RENDER.messageLimit)) {
    lastMessageId = (await client.send(channelId, chunk, traceId)) ?? lastMessageId;
  }
  return lastMessageId;
}
