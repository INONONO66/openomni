import { type Channel, Operational, PolicyDecision } from "@openomni/protocol";
import { newTraceId } from "@openomni/protocol";
import { Dedupe } from "../support/dedupe";
import { GitHubClient } from "./client";
import { GitHubNormalizer } from "./normalizer";
import type { GitHubEventContent, GitHubIssueCommentPayload, GitHubIssuesPayload } from "./types";
import type { PublishPort } from "../types";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "../channel-authn";

export interface GitHubAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

export class GitHubAdapter implements Channel.Surface {
  readonly id = "github";

  private readonly client: GitHubClient;
  private readonly normalizer: GitHubNormalizer;
  private readonly dedupe = new Dedupe();
  private handler: Channel.MessageHandler | null = null;

  constructor(
    private readonly secret: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    githubToken?: string,
    private readonly botUsername?: string,
    private readonly authOptions: GitHubAuthOptions = {},
  ) {
    this.client = new GitHubClient(publish, githubToken);
    this.normalizer = new GitHubNormalizer({
      botUsername,
      triggers: config.triggers,
    });
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(traceId: string): Promise<void> {
    if (!this.handler) {
      throw new Error("[github] No message handler registered. Call onMessage() before start().");
    }
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "github webhook handler ready",
    });
  }

  stop(_traceId: string): void {
    // no-op: GitHub adapter is webhook-based, no persistent connection to close
  }

  async handleWebhook(request: Request): Promise<Response> {
    // Origin: the first frame of an inbound webhook delivery — this ONE mint
    // is the message's trace, carried to the run (D11).
    const traceId = newTraceId();
    const auth = await ChannelAuthnMiddleware.authenticateGitHubWebhook({
      request,
      secret: this.secret,
      ...(this.authOptions.onDecision !== undefined
        ? { onDecision: this.authOptions.onDecision }
        : {}),
    });
    if (auth.response) return auth.response;

    const body = auth.body ?? "";

    const deliveryId = request.headers.get("x-github-delivery");
    if (deliveryId && this.dedupe.isDuplicate(deliveryId)) {
      return new Response("Already processed", { status: 200 });
    }

    const event = request.headers.get("x-github-event");
    if (!event) return new Response("Missing event", { status: 400 });

    const payload = JSON.parse(body) as Record<string, unknown>;
    const eventKey = `${event}.${payload.action}`;
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "github event received",
      // deliveryId: GitHub's own per-delivery id (x-github-delivery) — the
      // natural correlation key between this trace and GitHub's audit log.
      context: { event: eventKey, deliveryId },
    });

    const content = this.extractContent(event, payload);
    if (!content) return new Response("Unsupported event", { status: 200 });

    const triggerAuth = ChannelAuthnMiddleware.authenticateGitHubTriggers({
      triggers: this.config.triggers,
      ctx: {
        event: eventKey,
        mentioned: this.botUsername ? content.text.includes(`@${this.botUsername}`) : false,
        senderId: content.sender,
        channelId: `${content.issueKind}-${content.issueNumber}`,
        labels: content.labels,
        text: content.text,
      },
      ...(this.authOptions.onDecision !== undefined
        ? { onDecision: this.authOptions.onDecision }
        : {}),
    });
    if (PolicyDecision.isBlocking(triggerAuth.verdict))
      return new Response("Filtered", { status: 200 });

    const inbound = this.normalizer.normalize(content, eventKey, traceId, deliveryId ?? undefined);
    if (!inbound) return new Response("Filtered", { status: 200 });

    this.publish(Operational.Events.Debug, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "github message received",
      context: {
        repo: content.repo,
        issue: content.issueNumber,
        event: eventKey,
      },
    });

    try {
      const outbound = await this.getHandler()(inbound);
      if (outbound?.text) {
        await this.client.postComment(
          content.repo,
          content.issueNumber,
          outbound.text,
          traceId,
          deliveryId ?? undefined,
        );
      }
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "github message handler error",
        context: {
          repo: content.repo,
          issue: content.issueNumber,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
      if (deliveryId) this.dedupe.forget(deliveryId);
      return new Response("Processing failed", { status: 500 });
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
          // `||`, not `??`: GitHub sends empty-STRING bodies too — an issue
          // opened with no body must fall back to its title, or the empty
          // normalization drop (#606) silently vanishes a label-triggered event.
          text: p.issue.body || p.issue.title,
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

  private getHandler(): Channel.MessageHandler {
    if (!this.handler) {
      throw new Error(`[${this.id}] No handler registered. Call onMessage() before processing.`);
    }
    return this.handler;
  }
}
