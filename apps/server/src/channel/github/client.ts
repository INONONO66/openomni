import { Operational } from "@openomni/protocol";
import { fetchWithRetry } from "../support/fetch-retry";
import type { PublishPort } from "../types";

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
  ): Promise<void> {
    if (!this.token) return;

    const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "openomni-server",
        },
        body: JSON.stringify({ body }),
      },
      {
        publish: this.publish,
        label: "github/postComment",
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API failed (${response.status}): ${text}`);
    }

    this.publish(Operational.Debug, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "github comment posted",
      context: { repo, issueNumber },
    });
  }
}
