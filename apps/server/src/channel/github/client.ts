import { Log } from "@openomni/session";
import { fetchWithRetry } from "../../shared/fetch-retry";

export class GitHubClient {
  constructor(private readonly token?: string) {}

  async postComment(repo: string, issueNumber: number, body: string): Promise<void> {
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
      { label: "github/postComment" },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API failed (${response.status}): ${text}`);
    }

    Log.debug("github comment posted", { repo, issueNumber });
  }
}
