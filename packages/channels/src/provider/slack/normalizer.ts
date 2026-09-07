import type { Channel } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { SlackMessageEvent } from "./types";

export interface SlackNormalizerContext {
  botUserId: string;
  /** Workspace (team) id from `auth.test` — the surface-key namespace AND the sender-id prefix. */
  team: string;
}

export class SlackNormalizer implements InboundNormalizer<SlackMessageEvent> {
  constructor(private readonly ctx: SlackNormalizerContext) {}

  normalize(event: SlackMessageEvent): Channel.InboundMessage | null {
    // Bots (including this one) and subtyped frames (edits, joins, bot posts)
    // are not user messages.
    if (event.bot_id !== undefined || event.subtype !== undefined) return null;
    if (event.user === undefined || event.user === this.ctx.botUserId) return null;
    if (!event.text) return null;

    const isDM = event.channel_type === "im";
    const mentions = [...event.text.matchAll(/<@([^>]+)>/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );

    return {
      sender: { kind: "external", surface: "slack", externalId: `${this.ctx.team}:${event.user}` },
      facts: {
        eventId: event.ts,
        surface: "slack",
        workspaceId: this.ctx.team,
        channelId: event.channel,
        addressees: [...new Set(mentions)].map((id) => ({ externalId: `${this.ctx.team}:${id}` })),
        dm: isDM,
        ...(event.thread_ts !== undefined
          ? { reply: { chain: [event.thread_ts], threadId: event.thread_ts } }
          : {}),
        payload: event,
        render: event.text,
      },
    };
  }
}
