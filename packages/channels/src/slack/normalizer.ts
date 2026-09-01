import { Channel } from "@openomni/protocol";
import { normalizeContent } from "../support/trigger";
import type { InboundNormalizer } from "../types";
import type { SlackMessageEvent } from "./types";

export interface SlackNormalizerContext {
  botUserId: string;
  /** Workspace (team) id from `auth.test` — the surface-key namespace AND the sender-id prefix. */
  team: string;
  triggers: Channel.Config["triggers"];
}

export class SlackNormalizer implements InboundNormalizer<SlackMessageEvent> {
  constructor(private readonly ctx: SlackNormalizerContext) {}

  normalize(event: SlackMessageEvent, traceId: string): Channel.InboundMessage | null {
    // Bots (including this one) and subtyped frames (edits, joins, bot posts)
    // are not user messages.
    if (event.bot_id !== undefined || event.subtype !== undefined) return null;
    if (event.user === undefined || event.user === this.ctx.botUserId) return null;
    if (!event.text) return null;

    const isDM = event.channel_type === "im";
    const mentioned = event.text.includes(`<@${this.ctx.botUserId}>`);

    let content = event.text;
    if (mentioned && !isDM) {
      content = content.replaceAll(new RegExp(`<@${this.ctx.botUserId}>\\s*`, "g"), "").trim();
    }
    content = normalizeContent(content, this.ctx.triggers);
    if (!content) return null;

    const surfaceKey = Channel.SurfaceKey.fromChannel({
      surface: "slack",
      namespace: this.ctx.team,
      kind: isDM ? "dm" : "channel",
      id: isDM ? event.user : event.channel,
      ...(event.thread_ts !== undefined ? { threadId: event.thread_ts } : {}),
    });

    return {
      id: event.ts,
      traceId,
      surfaceKey,
      text: content,
      sender: {
        // Workspace-mandatory endpoint key (docs/provisioning-and-providers.md):
        // slack user ids are only unique per workspace, so the ActorEndpoint
        // externalId carries both halves.
        id: `${this.ctx.team}:${event.user}`,
      },
      ...(event.thread_ts !== undefined ? { threadId: event.thread_ts } : {}),
      raw: event,
    };
  }
}
