import { type Channel, Operational, PolicyDecision } from "@openomni/protocol";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "../../channel-authn";
import { Dedupe, DedupeWindow } from "../../support/dedupe";
import { chunkMarkdown } from "../../support/format/chunk";
import { SLACK_RENDER } from "./format";
import { newTraceId } from "../../support/trace";
import type { ChannelClient, PublishPort } from "../../types";
import { SlackClient } from "./client";
import { SlackEndpointKeyError, SlackHandlerMissingError } from "./error";
import { SlackNormalizer } from "./normalizer";
import { SlackSocket } from "./socket";
import type { SlackMessageEvent, SocketEnvelope } from "./types";

export interface SlackAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

export class SlackAdapter implements Channel.Surface {
  readonly id = "slack";

  private readonly client: SlackClient;
  private readonly socket: SlackSocket;
  private readonly dedupe = new Dedupe();
  private readonly outboundDedupe = new DedupeWindow<{ externalMessageId?: string }>();
  private normalizer: SlackNormalizer | null = null;
  private botUserId: string | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    credentials: { botToken: string; appToken: string },
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly authOptions: SlackAuthOptions = {},
  ) {
    this.client = new SlackClient(credentials.botToken, credentials.appToken, publish);
    this.socket = new SlackSocket(
      (traceId) => this.client.openSocketUrl(traceId),
      { onEvent: (envelope, traceId) => this.handleEnvelope(envelope, traceId) },
      publish,
    );
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(traceId: string): Promise<void> {
    if (!this.handler) {
      throw new SlackHandlerMissingError({
        message: "[slack] No message handler registered. Call onMessage() before start().",
      });
    }
    // Identity BEFORE the socket: mention detection, self-filtering, and
    // workspace-scoped keys all need the bot user id and team id.
    const identity = await this.client.authTest(traceId);
    this.botUserId = identity.botUserId;
    this.normalizer = new SlackNormalizer({
      botUserId: identity.botUserId,
      team: identity.team,
      triggers: this.config.triggers,
    });
    await this.socket.start();
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "slack bot started",
      context: { botUserId: identity.botUserId, team: identity.team },
    });
  }

  stop(traceId: string): void {
    this.socket.stop();
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "slack bot stopped",
    });
  }

  /**
   * Existing-agent delivery. The registered ActorEndpoint externalId is the
   * workspace-mandatory `TEAM:USER` pair (docs/provisioning-and-providers.md)
   * — a bare user id is refused, never guessed at.
   */
  async deliver(
    externalId: string,
    body: string,
    idempotencyKey?: string,
  ): Promise<{ externalMessageId?: string }> {
    const send = async (): Promise<{ externalMessageId?: string }> => {
      const [team, user] = externalId.split(":");
      if (!(team && user)) {
        throw new SlackEndpointKeyError({
          message: `slack endpoint externalId must be "TEAM:USER", got "${externalId}"`,
        });
      }
      // Origin: the messaging kernel's deliver seam does not thread the
      // sender's trace yet (#215) — this delivery is its own causal chain.
      const traceId = newTraceId();
      const channelId = await this.client.openDm(user, traceId);
      const externalMessageId = await sendSlackMessage(
        this.client,
        channelId,
        { text: body },
        traceId,
      );
      return externalMessageId === undefined ? {} : { externalMessageId };
    };
    return idempotencyKey === undefined ? send() : this.outboundDedupe.run(idempotencyKey, send);
  }

  private handleEnvelope(envelope: SocketEnvelope, traceId: string): void {
    const event = envelope.payload?.event;
    if (event === undefined || event.type !== "message") return;
    this.handleMessageEvent(event, traceId);
  }

  private handleMessageEvent(event: SlackMessageEvent, traceId: string): void {
    const normalizer = this.normalizer;
    const botUserId = this.botUserId;
    if (!(normalizer && botUserId)) return;
    // Socket Mode is at-least-once (unacked envelopes redeliver): dedupe by
    // the platform-unique (channel, ts) pair before anything acts.
    const acquisition = this.dedupe.acquire(`${event.channel}:${event.ts}`);
    if (acquisition.duplicate) return;
    const dedupeToken = acquisition.token;

    const inbound = normalizer.normalize(event, traceId);
    if (!inbound) return;

    const auth = ChannelAuthnMiddleware.authenticateSlackTriggers({
      triggers: this.config.triggers,
      ctx: {
        event: "message",
        mentioned: event.text?.includes(`<@${botUserId}>`) ?? false,
        channelId: event.channel,
        senderId: inbound.sender.id,
        isDM: event.channel_type === "im",
        text: event.text ?? "",
      },
      ...(this.authOptions.onDecision !== undefined
        ? { onDecision: this.authOptions.onDecision }
        : {}),
    });
    if (PolicyDecision.isBlocking(auth.verdict)) return;

    this.handleIncoming(inbound, event, traceId).catch((err) => {
      this.dedupe.forget(`${event.channel}:${event.ts}`, dedupeToken);
      this.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "slack message handling failed",
        context: { err: String(err) },
      });
    });
  }

  private async handleIncoming(
    inbound: Channel.InboundMessage,
    event: SlackMessageEvent,
    traceId: string,
  ): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    const outbound = await handler(inbound);
    if (!outbound) return;
    // Replies stay in the thread the message arrived in (a threaded reply
    // outside its thread reads as a non-sequitur in the channel).
    await sendSlackMessage(this.client, event.channel, outbound, traceId, event.thread_ts);
  }
}


async function sendSlackMessage(
  client: ChannelClient & Pick<SlackClient, "sendInThread">,
  channelId: string,
  message: Channel.OutboundMessage,
  traceId: string,
  threadTs?: string,
): Promise<string | undefined> {
  if (!message.text) return undefined;
  let lastMessageId: string | undefined;
  for (const chunk of chunkMarkdown(SLACK_RENDER.renderMarkdown(message.text), SLACK_RENDER.messageLimit)) {
    const ts =
      threadTs === undefined
        ? await client.send(channelId, chunk, traceId)
        : await client.sendInThread(channelId, threadTs, chunk, traceId);
    lastMessageId = ts ?? lastMessageId;
  }
  return lastMessageId;
}
