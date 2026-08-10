import { Adapter } from "@openomni/protocol";
import { normalizeContent } from "../../shared/trigger";
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
    const surfaceKey = Adapter.SurfaceKey.fromChannel({
      surface: "github",
      namespace: content.repo,
      kind: "channel",
      id: `${content.issueKind}-${content.issueNumber}`,
    });

    const normalizedText = normalizeContent(content.text, this.ctx.triggers, this.ctx.botUsername);

    return {
      id:
        deliveryId ?? `${eventKey}-${content.issueNumber}-${content.sender}-${content.text.length}`,
      surfaceKey,
      text: normalizedText,
      sender: { id: content.sender, name: content.sender },
      threadId: `${content.issueKind}-${content.issueNumber}`,
      raw: content,
    };
  }
}
