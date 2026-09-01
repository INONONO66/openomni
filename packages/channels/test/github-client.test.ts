import { describe, expect, it } from "bun:test";
import { GitHubClient } from "../src/provider/github/client";
import { fetchWithRetry } from "../src/support/fetch-retry";

describe("GitHubClient", () => {
  it("records a warn instead of silently skipping a reply without a token (#606)", async () => {
    const published: Array<{ name: string; data: Record<string, unknown> }> = [];
    const client = new GitHubClient((descriptor, data) => {
      published.push({ name: descriptor.name, data: data as Record<string, unknown> });
    });

    await client.postComment("openomni/project", 7, "the answer", "trace-github-test");

    expect(published).toEqual([
      {
        name: "operational.warn",
        data: expect.objectContaining({
          traceId: "trace-github-test",
          msg: "github token missing — reply not posted",
          context: { repo: "openomni/project", issueNumber: 7 },
        }),
      },
    ]);
  });

  it("exhausts rate-limit retries with one trace and a typed failure", async () => {
    const realFetch = globalThis.fetch;
    const warnings: Array<Record<string, unknown>> = [];
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return Response.json({ retryAfter: 0 }, { status: 429 });
    }) as unknown as typeof fetch;

    try {
      await expect(
        fetchWithRetry(
          "https://api.github.test/comments",
          { method: "POST" },
          {
            traceId: "trace-rate-limit",
            label: "github/postComment",
            parseRetryAfter: (body) => (body as { retryAfter: number }).retryAfter,
            publish: (_event, data) => warnings.push(data as Record<string, unknown>),
          },
        ),
      ).rejects.toThrow("github/postComment: rate limited after 3 retries");

      expect(attempts).toBe(4);
      expect(warnings.map((warning) => warning.traceId)).toEqual([
        "trace-rate-limit",
        "trace-rate-limit",
        "trace-rate-limit",
      ]);
      expect(warnings.map((warning) => warning.context)).toEqual([
        { label: "github/postComment", retryAfter: 0, attempt: 1, max: 3 },
        { label: "github/postComment", retryAfter: 0, attempt: 2, max: 3 },
        { label: "github/postComment", retryAfter: 0, attempt: 3, max: 3 },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
