import type { Adapter } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import { evaluateTriggers, normalizeContent } from "../../shared/trigger";
import type { GitHubEventContent } from "./types";

export interface GitHubNormalizerContext {
  botUsername?: string;
  triggers: Adapter.Config["triggers"];
}

export class GitHubNormalizer {
  constructor(private readonly ctx: GitHubNormalizerContext) {}

  normalize(
    content: GitHubEventContent,
    eventKey: string,
    deliveryId?: string,
  ): Adapter.InboundMessage | null {
    const triggerCtx: Adapter.TriggerContext = {
      event: eventKey,
      mentioned: this.checkMention(content.text),
      senderId: content.sender,
      channelId: `${content.issueKind}-${content.issueNumber}`,
      labels: content.labels,
      text: content.text,
    };

    if (!evaluateTriggers(this.ctx.triggers, triggerCtx)) return null;

    const surfaceKey = SurfaceKey.fromChannel({
      surface: "github",
      namespace: content.repo,
      kind: "channel",
      id: `${content.issueKind}-${content.issueNumber}`,
    });

    const normalizedText = normalizeContent(content.text, this.ctx.triggers, this.ctx.botUsername);

    return {
      id: deliveryId ?? `${eventKey}-${content.issueNumber}`,
      surfaceKey,
      text: normalizedText,
      sender: { id: content.sender, name: content.sender },
      threadId: `${content.issueKind}-${content.issueNumber}`,
      raw: content,
    };
  }

  private checkMention(text: string): boolean {
    if (!this.ctx.botUsername) return false;
    return text.includes(`@${this.ctx.botUsername}`);
  }
}
