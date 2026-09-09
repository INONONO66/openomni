import { describe, expect, it } from "bun:test";
import { GitHubAdapter } from "../src/provider/github/surface";
import { signedWebhook } from "./helpers/github";

const secret = "github-webhook-secret";
const deliveryId = "delivery-retry-1";
const body = JSON.stringify({
  action: "created",
  issue: {
    number: 7,
    title: "Run work",
    labels: [],
    user: { login: "octocat", type: "User" },
  },
  comment: {
    id: 1,
    body: "run",
    user: { login: "octocat", type: "User" },
  },
  repository: {
    full_name: "openomni/project",
    owner: { login: "openomni" },
    name: "project",
  },
});

const config = {};

describe("GitHubAdapter retryable delivery failures", () => {
  it("returns 5xx when the message handler throws", async () => {
    const adapter = new GitHubAdapter(secret, config, () => undefined);
    let attempts = 0;
    adapter.onMessage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler unavailable");
    });

    const response = await adapter.handleWebhook(await webhookRequest(deliveryId));

    expect(response.status).toBe(500);
    const retried = await adapter.handleWebhook(await webhookRequest(deliveryId));
    expect(retried.status).toBe(200);
    expect(attempts).toBe(2);
  });
});

function webhookRequest(id: string): Request {
  return signedWebhook(body, secret, id);
}
