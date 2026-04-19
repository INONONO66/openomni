import type { Adapter } from "@openomni/protocol";
import { Log, SurfaceKey } from "@openomni/session";
import { Dedupe } from "../../shared/dedupe";
import { GitHubClient } from "./client";
import { GitHubNormalizer } from "./normalizer";
import type { GitHubEventContent, GitHubIssueCommentPayload, GitHubIssuesPayload } from "./types";
import { verifyGitHubSignature } from "./webhook";

export class GitHubAdapter implements Adapter.Surface {
  readonly id = "github";
  readonly capabilities: Adapter.Capabilities = {
    streaming: false,
    media: { send: false, receive: false },
    commands: false,
    threads: true,
  };

  private readonly client: GitHubClient;
  private readonly normalizer: GitHubNormalizer;
  private readonly dedupe = new Dedupe();
  private handler: Adapter.MessageHandler | null = null;

  constructor(
    private readonly secret: string,
    readonly config: Adapter.Config,
    githubToken?: string,
    private readonly botUsername?: string,
  ) {
    this.client = new GitHubClient(githubToken);
    this.normalizer = new GitHubNormalizer({
      botUsername,
      triggers: config.triggers,
    });
  }

  onMessage(handler: Adapter.MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error("[github] No message handler registered. Call onMessage() before start().");
    }
    Log.info("github webhook handler ready");
  }

  stop(): void {
    // no-op: GitHub adapter is webhook-based, no persistent connection to close
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const parsed = SurfaceKey.parse(surfaceKey);
    const repo = parsed.namespace;
    const issueNumber = parseInt((parsed.id ?? "").split("-")[1]);

    if (Number.isNaN(issueNumber)) {
      Log.error("github invalid surface key", { surfaceKey });
      return;
    }

    if (message.text) {
      await this.client.postComment(repo, issueNumber, message.text);
    }
  }

  async handleWebhook(request: Request): Promise<Response> {
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature) return new Response("Missing signature", { status: 401 });

    const body = await request.text();
    const valid = await verifyGitHubSignature(body, signature, this.secret);
    if (!valid) return new Response("Invalid signature", { status: 401 });

    const deliveryId = request.headers.get("x-github-delivery");
    if (deliveryId && this.dedupe.isDuplicate(deliveryId)) {
      return new Response("Already processed", { status: 200 });
    }

    const event = request.headers.get("x-github-event");
    if (!event) return new Response("Missing event", { status: 400 });

    const payload = JSON.parse(body) as Record<string, unknown>;
    const eventKey = `${event}.${payload.action}`;
    Log.info("github event received", { event: eventKey });

    const content = this.extractContent(event, payload);
    if (!content) return new Response("Unsupported event", { status: 200 });

    const inbound = this.normalizer.normalize(content, eventKey, deliveryId ?? undefined);
    if (!inbound) return new Response("Filtered", { status: 200 });

    Log.debug("github message received", {
      repo: content.repo,
      issue: content.issueNumber,
      event: eventKey,
    });

    try {
      const outbound = await this.getHandler()(inbound);
      if (outbound?.text) {
        await this.client.postComment(content.repo, content.issueNumber, outbound.text);
      }
    } catch (err) {
      Log.error("github message handler error", {
        repo: content.repo,
        issue: content.issueNumber,
        err: String(err),
      });
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

  private getHandler(): Adapter.MessageHandler {
    if (!this.handler) {
      throw new Error(`[${this.id}] No handler registered. Call onMessage() before processing.`);
    }
    return this.handler;
  }
}
