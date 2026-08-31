import { describe, expect, it } from "bun:test";
import { GitHubNormalizer } from "../src/github/normalizer";

describe("GitHubNormalizer", () => {
  const normalizer = new GitHubNormalizer({ triggers: [], botUsername: "bot" });

  it("drops a comment that normalizes to nothing — no empty-payload dispatch (#606)", () => {
    const inbound = normalizer.normalize(
      {
        repo: "openomni/project",
        issueKind: "issue",
        issueNumber: 7,
        sender: "octocat",
        senderType: "User",
        text: "@bot",
        labels: [],
      },
      "issue_comment.created",
      "trace-github-test",
    );

    expect(inbound).toBeNull();
  });

  it("keeps real content", () => {
    const inbound = normalizer.normalize(
      {
        repo: "openomni/project",
        issueKind: "issue",
        issueNumber: 7,
        sender: "octocat",
        senderType: "User",
        text: "@bot please review",
        labels: [],
      },
      "issue_comment.created",
      "trace-github-test",
    );

    expect(inbound?.text).toBe("please review");
  });
});
