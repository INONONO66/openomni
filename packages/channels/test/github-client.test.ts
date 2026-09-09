import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { GitHubClient } from "../src/provider/github/client";
import { fetchWithRetry } from "../src/support/fetch-retry";

describe("GitHubClient", () => {
  it("records a warn instead of silently skipping a reply without a token (#606)", async () => {
    const schema = z.object({
      traceId: z.string(),
      context: z.object({ repo: z.string(), issueNumber: z.number() }),
    });
    const published: Array<{ name: string; data: z.infer<typeof schema> }> = [];
    const client = new GitHubClient((descriptor, data) => {
      published.push({ name: descriptor.name, data: schema.parse(data) });
    });

    await client.postComment("openomni/project", 7, "the answer", "trace-github-test");

    expect(published).toEqual([
      {
        name: "operational.warn",
        data: {
          traceId: "trace-github-test",
          context: { repo: "openomni/project", issueNumber: 7 },
        },
      },
    ]);
  });

  it("exhausts rate-limit retries with one trace and a typed failure", async () => {
    const realFetch = globalThis.fetch;
    const warningSchema = z.object({
      traceId: z.string(),
      context: z.object({
        label: z.string(),
        retryAfter: z.number(),
        attempt: z.number(),
        max: z.number(),
      }),
    });
    const warnings: z.infer<typeof warningSchema>[] = [];
    let attempts = 0;
    globalThis.fetch = Object.assign(
      async () => {
        attempts += 1;
        return Response.json({ retryAfter: 0 }, { status: 429 });
      },
      { preconnect: realFetch.preconnect },
    );

    try {
      await expect(
        fetchWithRetry(
          "https://api.github.test/comments",
          { method: "POST" },
          {
            traceId: "trace-rate-limit",
            label: "github/postComment",
            retryAfterSchema: z
              .object({ retryAfter: z.number() })
              .transform((body) => body.retryAfter),
            publish: (_event, data) => warnings.push(warningSchema.parse(data)),
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
