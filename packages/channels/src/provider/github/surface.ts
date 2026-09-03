import { newTraceId } from "../../support/trace";
import { type Channel, Operational, PolicyDecision } from "@openomni/protocol";
import { z } from "zod";
import { Dedupe, type DedupeToken } from "../../support/dedupe";
import { requireHandler } from "../../support/handler-frame";
import { GitHubClient } from "./client";
import { GitHubNormalizer } from "./normalizer";
import {
  type GitHubEventContent,
  type GitHubIssuePayload,
  type GitHubUser,
  GitHubWebhookPayloadSchemas,
} from "./types";
import type { PublishPort } from "../../types";
import {
  ChannelAuthnMiddleware,
  type ChannelAuthnDecisionObserver,
  decisionOption,
} from "../../channel-authn";

interface GitHubAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

/** Every webhook payload carries `action`; unsupported events may not — optional keeps the event-key log honest. */
const EventActionSchema = z.object({ action: z.string().optional() });

function actionOf(raw: object): string | undefined {
  const parsed = EventActionSchema.safeParse(raw);
  return parsed.success ? parsed.data.action : undefined;
}

/** Shared shape of both supported payloads — one construction site, not two cloned literals. */
function issueContent(
  text: string,
  user: GitHubUser,
  payload: GitHubIssuePayload,
): GitHubEventContent | null {
  if (user.type === "Bot") return null;
  return {
    text,
    sender: user.login,
    senderType: user.type,
    repo: payload.repository.full_name,
    issueNumber: payload.issue.number,
    issueKind: payload.issue.pull_request ? "pr" : "issue",
    labels: (payload.issue.labels ?? []).map((label) => label.name),
  };
}

function extractContent(event: string, raw: object): GitHubEventContent | null {
  if (event === "issue_comment") {
    const parsed = GitHubWebhookPayloadSchemas.issue_comment.safeParse(raw);
    if (!parsed.success || parsed.data.action !== "created") return null;
    return issueContent(parsed.data.comment.body, parsed.data.comment.user, parsed.data);
  }
  if (event === "issues") {
    const parsed = GitHubWebhookPayloadSchemas.issues.safeParse(raw);
    if (!parsed.success || parsed.data.action !== "opened") return null;
    // `||`, not `??`: GitHub sends empty-STRING bodies too — an issue opened
    // with no body must fall back to its title, or the empty normalization
    // drop (#606) silently vanishes a label-triggered event.
    return issueContent(
      parsed.data.issue.body || parsed.data.issue.title,
      parsed.data.issue.user,
      parsed.data,
    );
  }
  return null;
}

type PreparedWebhook = Readonly<{
  traceId: string;
  deliveryId: string | null;
  dedupeToken: DedupeToken | undefined;
  content: GitHubEventContent;
  inbound: Channel.InboundMessage;
}>;

type WebhookPreparation = PreparedWebhook | Readonly<{ response: Response }>;

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
    requireHandler(this.handler, "github");
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
      ...decisionOption(this.authOptions.onDecision),
    });
    if (auth.response) return auth.response;

    const preparation = this.prepareWebhook(request, auth.body ?? "", traceId);
    if ("response" in preparation) return preparation.response;

    return this.dispatchWebhook(preparation);
  }

  private prepareWebhook(request: Request, body: string, traceId: string): WebhookPreparation {
    const deliveryId = request.headers.get("x-github-delivery");
    const dedupeAcquisition = deliveryId === null ? undefined : this.dedupe.acquire(deliveryId);
    if (dedupeAcquisition?.duplicate) {
      return { response: new Response("Already processed", { status: 200 }) };
    }
    const dedupeToken = dedupeAcquisition?.token;

    const event = request.headers.get("x-github-event");
    if (!event) return { response: new Response("Missing event", { status: 400 }) };

    const raw: object = JSON.parse(body);
    const eventKey = `${event}.${actionOf(raw)}`;
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "github event received",
      // deliveryId: GitHub's own per-delivery id (x-github-delivery) — the
      // natural correlation key between this trace and GitHub's audit log.
      context: { event: eventKey, deliveryId },
    });

    const content = extractContent(event, raw);
    if (!content) {
      return { response: new Response("Unsupported event", { status: 200 }) };
    }

    if (this.triggerBlocks(content, eventKey)) {
      return { response: new Response("Filtered", { status: 200 }) };
    }

    const inbound = this.normalizer.normalize(content, eventKey, traceId, deliveryId ?? undefined);
    if (!inbound) return { response: new Response("Filtered", { status: 200 }) };

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

    return { traceId, deliveryId, dedupeToken, content, inbound };
  }

  private triggerBlocks(content: GitHubEventContent, eventKey: string): boolean {
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
      ...decisionOption(this.authOptions.onDecision),
    });
    return PolicyDecision.isBlocking(triggerAuth.verdict);
  }

  /** The run-and-reply frame: a handler throw or comment failure releases the delivery claim and returns 500 so GitHub retries. */
  private async dispatchWebhook(prepared: PreparedWebhook): Promise<Response> {
    try {
      const outbound = await (this.handler as Channel.MessageHandler)(prepared.inbound);
      if (outbound?.text) {
        await this.client.postComment(
          prepared.content.repo,
          prepared.content.issueNumber,
          outbound.text,
          prepared.traceId,
          prepared.deliveryId ?? undefined,
        );
      }
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId: prepared.traceId,
        time: Date.now(),
        component: "server",
        msg: "github message handler error",
        context: {
          repo: prepared.content.repo,
          issue: prepared.content.issueNumber,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
      if (prepared.deliveryId && prepared.dedupeToken !== undefined) {
        this.dedupe.forget(prepared.deliveryId, prepared.dedupeToken);
      }
      return new Response("Processing failed", { status: 500 });
    }

    return new Response("OK", { status: 200 });
  }
}
