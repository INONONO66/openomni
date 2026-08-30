import { type Channel, Operational, PolicyDecision } from "@openomni/protocol";
import { newTraceId } from "@openomni/protocol";
import { Dedupe, DedupeWindow } from "../support/dedupe";
import { DiscordClient } from "./client";
import { DiscordHandlerMissingError } from "./error";
import { DiscordGateway } from "./gateway";
import { DiscordNormalizer } from "./normalizer";
import type { DiscordMessage } from "./types";
import type { PublishPort } from "../types";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "../channel-authn";

export interface DiscordAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

export class DiscordAdapter implements Channel.Surface {
  readonly id = "discord";

  private readonly client: DiscordClient;
  private readonly gateway: DiscordGateway;
  private readonly dedupe = new Dedupe();
  private readonly outboundDedupe = new DedupeWindow<{ externalMessageId?: string }>();
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
          this.handleMessageCreate(data as DiscordMessage, traceId);
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
  async deliver(
    externalId: string,
    body: string,
    idempotencyKey?: string,
  ): Promise<{ externalMessageId?: string }> {
    const send = async (): Promise<{ externalMessageId?: string }> => {
      // Origin: the messaging kernel's deliver seam does not thread the
      // sender's trace yet (#215) — this delivery is its own causal chain.
      const traceId = newTraceId();
      const channelId = await this.client.createDmChannel(externalId, traceId);
      const externalMessageId = await sendDiscordMessage(
        this.client,
        channelId,
        { text: body },
        traceId,
      );
      return externalMessageId === undefined ? {} : { externalMessageId };
    };
    // Additive capability only: the current server composition calls this
    // seam without a key, which intentionally retains at-least-once behavior.
    return idempotencyKey === undefined ? send() : this.outboundDedupe.run(idempotencyKey, send);
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
      ...(this.authOptions.onDecision !== undefined
        ? { onDecision: this.authOptions.onDecision }
        : {}),
    });
    if (PolicyDecision.isBlocking(auth.verdict)) return;

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

    const handler = this.handler;
    if (!handler) return;

    this.client.sendTyping(channelId, traceId);
    const typingInterval = setInterval(() => {
      this.client.sendTyping(channelId, traceId);
    }, 8000);

    try {
      const outbound = await handler(inbound);
      if (outbound) await sendDiscordMessage(this.client, channelId, outbound, traceId);
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "discord message handler error",
        context: { channelId, err: String(err) },
      });
      await sendDiscordMessage(
        this.client,
        channelId,
        { text: "Sorry, an error occurred." },
        traceId,
      );
    } finally {
      clearInterval(typingInterval);
    }
  }
}

// merged from formatter.ts (#453 hygiene: sub-30-LOC single-importer)
import { splitText } from "../support/chunk-text";
import type { ChannelClient } from "../types";

const DISCORD_MESSAGE_LIMIT = 2000;

async function sendDiscordMessage(
  client: ChannelClient,
  channelId: string,
  message: Channel.OutboundMessage,
  traceId: string,
): Promise<string | undefined> {
  if (!message.text) return undefined;
  let lastMessageId: string | undefined;
  for (const chunk of splitText(message.text, DISCORD_MESSAGE_LIMIT)) {
    lastMessageId = (await client.send(channelId, chunk, traceId)) ?? lastMessageId;
  }
  return lastMessageId;
}
