import { describe, expect, it } from "bun:test";
import { GitHubClient } from "../src/github/client";

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
});
