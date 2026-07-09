import type { Adapter } from "@openomni/protocol";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus, SurfaceKey } from "@openomni/session";
import { Dedupe } from "../../shared/dedupe";
import { DiscordClient } from "./client";
import { DiscordGateway } from "./gateway";
import { DiscordNormalizer } from "./normalizer";
import type { DiscordMessage } from "./types";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "../channel-authn";

export interface DiscordAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

export class DiscordAdapter implements Adapter.Surface {
  readonly id = "discord";
  readonly capabilities: Adapter.Capabilities = {
    streaming: false,
    media: { send: false, receive: false },
    commands: false,
    threads: true,
  };

  private readonly client: DiscordClient;
  private readonly gateway: DiscordGateway;
  private readonly dedupe = new Dedupe();
  private normalizer: DiscordNormalizer | null = null;
  private botId: string | null = null;
  private handler: Adapter.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Adapter.Config,
    private readonly authOptions: DiscordAuthOptions = {},
  ) {
    this.client = new DiscordClient(token);
    this.gateway = new DiscordGateway(token, () => this.client.fetchGatewayUrl(), {
      onReady: ({ botId, botUsername }) => {
        this.botId = botId;
        this.normalizer = new DiscordNormalizer({
          botId,
          triggers: this.config.triggers,
        });
        Bus.publish(Operational.Info, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "server",
          msg: "discord bot started",
          context: { username: botUsername, botId },
        });
      },
      onDispatch: (event, data) => {
        if (event !== "MESSAGE_CREATE") return;
        this.handleMessageCreate(data as DiscordMessage);
      },
    });
  }

  onMessage(handler: Adapter.MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error("[discord] No message handler registered. Call onMessage() before start().");
    }
    await this.gateway.start();
  }

  stop(): void {
    this.gateway.stop();
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "discord bot stopped",
    });
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const parsed = SurfaceKey.parse(surfaceKey);
    if (!parsed.id) {
      throw new Error(`[discord] surface key missing id: ${surfaceKey}`);
    }
    const channelId =
      parsed.kind === "dm" ? await this.client.createDmChannel(parsed.id) : parsed.id;
    await sendDiscordMessage(this.client, channelId, message);
  }

  private handleMessageCreate(message: DiscordMessage): void {
    if (!this.normalizer) return;
    if (this.dedupe.isDuplicate(message.id)) return;
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

    const inbound = this.normalizer.normalize(message);
    if (!inbound) return;

    this.handleIncoming(inbound, message.channel_id).catch((err) => {
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "discord message handling failed",
        context: { err: String(err) },
      });
    });
  }

  private async handleIncoming(inbound: Adapter.InboundMessage, channelId: string): Promise<void> {
    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "discord message received",
      context: { channelId },
    });

    const handler = this.handler;
    if (!handler) return;

    this.client.sendTyping(channelId);
    const typingInterval = setInterval(() => {
      this.client.sendTyping(channelId);
    }, 8000);

    try {
      const outbound = await handler(inbound);
      if (outbound) await sendDiscordMessage(this.client, channelId, outbound);
    } catch (err) {
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "discord message handler error",
        context: { channelId, err: String(err) },
      });
      await sendDiscordMessage(this.client, channelId, { text: "Sorry, an error occurred." });
    } finally {
      clearInterval(typingInterval);
    }
  }
}

// merged from formatter.ts (#453 hygiene: sub-30-LOC single-importer)
import { splitText } from "../../shared/chunk-text";
import type { ChannelClient } from "../types";

const DISCORD_MESSAGE_LIMIT = 2000;

export async function sendDiscordMessage(
  client: ChannelClient,
  channelId: string,
  message: Adapter.OutboundMessage,
): Promise<void> {
  if (!message.text) return;
  for (const chunk of splitText(message.text, DISCORD_MESSAGE_LIMIT)) {
    await client.send(channelId, chunk);
  }
}
