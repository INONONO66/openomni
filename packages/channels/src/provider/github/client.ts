import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { PublishPort } from "../../types";

/** One comment page from the list endpoint — only `body` is read, extra keys pass. */
const CommentsPageSchema = z.array(z.object({ body: z.string().optional() }));

export class GitHubClient {
  constructor(
    private readonly publish: PublishPort,
    private readonly token?: string,
  ) {}

  async postComment(
    repo: string,
    issueNumber: number,
    body: string,
    traceId: string,
    deliveryId?: string,
  ): Promise<void> {
    if (!this.token) {
      // Loud absence (#606 audit): a deployment with a webhook secret but no
      // token would receive events, spend a full run, then silently never
      // reply. The run's work must not vanish without a record.
      this.publish(Operational.Events.Warn, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "github token missing — reply not posted",
        context: { repo, issueNumber },
      });
      return;
    }

    const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "openomni-server",
    };
    const marker = deliveryId
      ? `<!-- openomni-delivery:${encodeURIComponent(deliveryId)} -->`
      : undefined;
    if (marker && (await this.hasComment(url, headers, marker, traceId))) {
      this.publish(Operational.Events.Debug, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "github comment already posted",
        context: { repo, issueNumber, deliveryId },
      });
      return;
    }

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body: marker ? `${body}\n\n${marker}` : body }),
      },
      {
        traceId,
        publish: this.publish,
        label: "github/postComment",
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API failed (${response.status}): ${text}`);
    }

    this.publish(Operational.Events.Debug, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "github comment posted",
      context: { repo, issueNumber },
    });
  }

  private async hasComment(
    url: string,
    headers: Record<string, string>,
    marker: string,
    traceId: string,
  ): Promise<boolean> {
    const perPage = 100;
    for (let page = 1; ; page += 1) {
      const response = await fetchWithRetry(
        `${url}?per_page=${perPage}&page=${page}`,
        { method: "GET", headers },
        {
          traceId,
          publish: this.publish,
          label: "github/listComments",
        },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub API failed (${response.status}): ${text}`);
      }

      const listing = CommentsPageSchema.safeParse(await response.json());
      if (!listing.success) throw new Error("GitHub API returned invalid comments");
      if (listing.data.some((comment) => comment.body?.includes(marker))) return true;
      if (listing.data.length < perPage) return false;
    }
  }
}
