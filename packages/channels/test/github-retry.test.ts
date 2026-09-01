import { describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { GitHubAdapter } from "../src/provider/github/surface";

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

const config = { triggers: [] } satisfies Channel.Config;

describe("GitHubAdapter retryable delivery failures", () => {
  it("returns 5xx when the message handler throws", async () => {
    const adapter = new GitHubAdapter(secret, config, () => undefined);
    adapter.onMessage(async () => {
      throw new Error("handler unavailable");
    });

    const response = await adapter.handleWebhook(await webhookRequest(deliveryId));

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it("redelivers after an accepted comment loses its response without duplicating durable work or the comment", async () => {
    const realFetch = globalThis.fetch;
    const durableComments: string[] = [];
    let readAttempts = 0;
    let postAttempts = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        readAttempts += 1;
        return Response.json(durableComments.map((commentBody) => ({ body: commentBody })));
      }

      postAttempts += 1;
      durableComments.push(JSON.parse(String(init?.body)).body);
      if (postAttempts === 1) throw new Error("comment accepted but response lost");
      return new Response("created", { status: 201 });
    }) as typeof fetch;

    try {
      const durableDecisionIds: string[] = [];
      let handlerExecutions = 0;
      const adapter = new GitHubAdapter(secret, config, () => undefined, "github-token");
      adapter.onMessage(async (message) => {
        handlerExecutions += 1;
        if (!durableDecisionIds.includes(message.id)) durableDecisionIds.push(message.id);
        return { text: "the answer" };
      });

      const failed = await adapter.handleWebhook(await webhookRequest(deliveryId));
      const retried = await adapter.handleWebhook(await webhookRequest(deliveryId));
      const duplicate = await adapter.handleWebhook(await webhookRequest(deliveryId));

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(retried.status).toBe(200);
      expect(await retried.text()).toBe("OK");
      expect(await duplicate.text()).toBe("Already processed");
      expect(handlerExecutions).toBe(2);
      expect(durableDecisionIds).toEqual([deliveryId]);
      expect(durableComments).toEqual([
        "the answer\n\n<!-- openomni-delivery:delivery-retry-1 -->",
      ]);
      expect(readAttempts).toBe(2);
      expect(postAttempts).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

async function webhookRequest(id: string): Promise<Request> {
  return new Request("http://localhost/github/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": await signGitHubBody(body),
      "x-github-event": "issue_comment",
      "x-github-delivery": id,
    },
    body,
  });
}

async function signGitHubBody(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return `sha256=${Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
