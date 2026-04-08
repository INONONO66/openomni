import { timingSafeEqual } from "node:crypto";
import type { Adapter } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import { Dedupe } from "../../shared/dedupe";
import { fetchWithRetry } from "../../shared/http-helpers";
import { evaluateTriggers, normalizeContent } from "../../shared/trigger";
import type { GitHubEventContent, GitHubIssueCommentPayload, GitHubIssuesPayload } from "./types";

export class GitHubAdapter implements Adapter.Surface {
  readonly id = "github";
  readonly capabilities: Adapter.Capabilities = {
    streaming: false,
    media: { send: false, receive: false },
    commands: false,
    threads: true,
  };

  private readonly dedupe = new Dedupe();
  private handler: Adapter.MessageHandler | null = null;

  constructor(
    private readonly secret: string,
    readonly config: Adapter.Config,
    private readonly githubToken?: string,
    private readonly botUsername?: string,
  ) {}

  onMessage(handler: Adapter.MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error("[github] No message handler registered. Call onMessage() before start().");
    }
    console.log("[github] Webhook handler ready");
  }

  stop(): void {
    // no-op: GitHub adapter is webhook-based, no persistent connection to close
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const parsed = SurfaceKey.parse(surfaceKey);
    const repo = parsed.namespace;
    const issueNumber = parseInt((parsed.id ?? "").split("-")[1]);

    if (Number.isNaN(issueNumber)) {
      console.error(`[github] Invalid surfaceKey: malformed issue id in "${surfaceKey}"`);
      return;
    }

    if (message.text && this.githubToken) {
      await this.postComment(repo, issueNumber, message.text);
    }
    // TODO: handle message.media when capabilities.media.send is enabled
  }

  async handleWebhook(request: Request): Promise<Response> {
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature) {
      return new Response("Missing signature", { status: 401 });
    }

    const body = await request.text();
    const valid = await this.verifySignature(body, signature);
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const deliveryId = request.headers.get("x-github-delivery");
    if (deliveryId && this.dedupe.isDuplicate(deliveryId)) {
      return new Response("Already processed", { status: 200 });
    }

    const event = request.headers.get("x-github-event");
    if (!event) {
      return new Response("Missing event", { status: 400 });
    }

    const payload = JSON.parse(body) as Record<string, unknown>;
    const eventKey = `${event}.${payload.action}`;

    console.log(`[github] Event: ${eventKey}`);

    const content = this.extractContent(event, payload);
    if (!content) {
      return new Response("Unsupported event", { status: 200 });
    }

    const ctx: Adapter.TriggerContext = {
      event: eventKey,
      mentioned: this.checkMention(content.text),
      senderId: content.sender,
      channelId: `${content.issueKind}-${content.issueNumber}`,
      labels: content.labels,
      text: content.text,
    };

    if (!evaluateTriggers(this.config.triggers, ctx)) {
      return new Response("Filtered", { status: 200 });
    }

    try {
      await this.processEvent(content, eventKey);
    } catch (err) {
      console.error(`[github] processing failed (event=${eventKey}):`, err);
    }

    return new Response("OK", { status: 200 });
  }

  private extractContent(event: string, payload: unknown): GitHubEventContent | null {
    switch (event) {
      case "issue_comment": {
        const p = payload as GitHubIssueCommentPayload;
        if (p.action !== "created") return null;
        if (p.comment.user.type === "Bot") return null;
        return {
          text: p.comment.body,
          sender: p.comment.user.login,
          senderType: p.comment.user.type,
          repo: p.repository.full_name,
          issueNumber: p.issue.number,
          issueKind: p.issue.pull_request ? "pr" : "issue",
          labels: p.issue.labels?.map((l) => l.name) ?? [],
        };
      }

      case "issues": {
        const p = payload as GitHubIssuesPayload;
        if (p.action !== "opened") return null;
        if (p.issue.user.type === "Bot") return null;
        return {
          text: p.issue.body ?? p.issue.title,
          sender: p.issue.user.login,
          senderType: p.issue.user.type,
          repo: p.repository.full_name,
          issueNumber: p.issue.number,
          issueKind: p.issue.pull_request ? "pr" : "issue",
          labels: p.issue.labels?.map((l) => l.name) ?? [],
        };
      }

      default:
        return null;
    }
  }

  private async processEvent(content: GitHubEventContent, eventKey: string): Promise<void> {
    const surfaceKey = SurfaceKey.fromChannel({
      surface: "github",
      namespace: content.repo,
      kind: "channel",
      id: `${content.issueKind}-${content.issueNumber}`,
    });

    console.log(
      `[github] ${content.repo}#${content.issueNumber} (${eventKey}): ${content.text.slice(0, 80)}`,
    );

    const normalizedText = normalizeContent(content.text, this.config.triggers, this.botUsername);

    try {
      const inbound: Adapter.InboundMessage = {
        id: `${eventKey}-${content.issueNumber}-${Date.now()}`,
        surfaceKey,
        text: normalizedText,
        sender: {
          id: content.sender,
          name: content.sender,
        },
        threadId: `${content.issueKind}-${content.issueNumber}`,
        raw: content,
      };

      const outbound = await this.getHandler()(inbound);

      if (outbound?.text && this.githubToken) {
        await this.postComment(content.repo, content.issueNumber, outbound.text);
      } else if (outbound?.text) {
        console.log(`[github] Response (no token, not posted):\n${outbound.text}`);
      }
    } catch (err) {
      console.error(`[github] Error in ${content.repo}#${content.issueNumber}:`, err);
    }
  }

  private getHandler(): Adapter.MessageHandler {
    if (!this.handler) {
      throw new Error(`[${this.id}] No handler registered. Call onMessage() before processing.`);
    }
    return this.handler;
  }

  private checkMention(text: string): boolean {
    if (!this.botUsername) return false;
    return text.includes(`@${this.botUsername}`);
  }

  private async postComment(repo: string, issueNumber: number, body: string): Promise<void> {
    const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "openomni-cli",
        },
        body: JSON.stringify({ body }),
      },
      { label: "github/postComment" },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API failed (${response.status}): ${text}`);
    }

    console.log(`[github] Posted comment to ${repo}#${issueNumber}`);
  }

  // constant-time comparison to prevent timing attacks
  private async verifySignature(payload: string, signature: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const digest = `sha256=${Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;

    if (signature.length !== digest.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  }
}
