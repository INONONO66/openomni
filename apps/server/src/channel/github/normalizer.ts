import { Adapter } from "@openomni/protocol";
import { normalizeContent } from "../support/trigger";
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
    traceId: string,
    deliveryId?: string,
  ): Adapter.InboundMessage | null {
    const surfaceKey = Adapter.SurfaceKey.fromChannel({
      surface: "github",
      namespace: content.repo,
      kind: "channel",
      id: `${content.issueKind}-${content.issueNumber}`,
    });

    const normalizedText = normalizeContent(content.text, this.ctx.triggers, this.ctx.botUsername);
    // Match the telegram/discord contract: a comment that normalizes to
    // nothing (e.g. a bare @mention) is dropped, not dispatched as an empty
    // run — the `| null` signature was previously unreachable (#606 audit).
    if (normalizedText.trim().length === 0) return null;

    return {
      id:
        deliveryId ?? `${eventKey}-${content.issueNumber}-${content.sender}-${content.text.length}`,
      traceId,
      surfaceKey,
      text: normalizedText,
      sender: { id: content.sender, name: content.sender },
      threadId: `${content.issueKind}-${content.issueNumber}`,
      raw: content,
    };
  }
}
