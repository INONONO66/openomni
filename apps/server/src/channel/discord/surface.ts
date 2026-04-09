import type { Adapter } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import { Dedupe } from "../../shared/dedupe";
import { DiscordClient } from "./client";
import { DiscordFormatter } from "./formatter";
import { DiscordGateway } from "./gateway";
import { DiscordNormalizer } from "./normalizer";
import type { DiscordMessage } from "./types";

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
  private readonly formatter = new DiscordFormatter();
  private readonly dedupe = new Dedupe();
  private normalizer: DiscordNormalizer | null = null;
  private handler: Adapter.MessageHandler | null = null;
  private botId = "";
  private botUsername = "";

  constructor(
    token: string,
    readonly config: Adapter.Config,
  ) {
    this.client = new DiscordClient(token);
    this.gateway = new DiscordGateway(token, () => this.client.fetchGatewayUrl(), {
      onReady: ({ botId, botUsername }) => {
        this.botId = botId;
        this.botUsername = botUsername;
        this.normalizer = new DiscordNormalizer({
          botId: this.botId,
          triggers: this.config.triggers,
        });
        console.log(`[discord] Bot started: @${this.botUsername} (${this.botId})`);
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
    console.log("[discord] Bot stopped");
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const parsed = SurfaceKey.parse(surfaceKey);
    let channelId = parsed.id ?? "";
    if (parsed.kind === "dm") {
      channelId = await this.client.createDmChannel(parsed.id ?? "");
    }
    await this.formatter.send(this.client, channelId, message);
  }

  private handleMessageCreate(message: DiscordMessage): void {
    if (!this.normalizer) return;
    if (this.dedupe.isDuplicate(message.id)) return;

    const inbound = this.normalizer.normalize(message);
    if (!inbound) return;

    this.handleIncoming(inbound, message.channel_id).catch((err) => {
      console.error("[discord] Error handling message:", err);
    });
  }

  private async handleIncoming(inbound: Adapter.InboundMessage, channelId: string): Promise<void> {
    console.log(`[discord] ${channelId}: ${inbound.text.slice(0, 80)}`);

    const handler = this.handler;
    if (!handler) return;

    this.client.sendTyping(channelId);
    const typingInterval = setInterval(() => {
      this.client.sendTyping(channelId);
    }, 8000);

    try {
      const outbound = await handler(inbound);
      if (outbound) await this.formatter.send(this.client, channelId, outbound);
    } catch (err) {
      console.error(`[discord] Error in ${channelId}:`, err);
      await this.formatter.send(this.client, channelId, { text: "Sorry, an error occurred." });
    } finally {
      clearInterval(typingInterval);
    }
  }
}
