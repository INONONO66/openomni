import { describe, expect, it } from "bun:test";
import type { Adapter } from "@openomni/protocol";
import type { ChannelAuthnDecisionObserver } from "../../src/channel/authn/types";
import { GitHubAdapter } from "../../src/channel/github/surface";

type ChannelAuthnDecision = Parameters<ChannelAuthnDecisionObserver>[0];

const secret = "github-webhook-secret";
const config = {
  triggers: [],
  deliveryPolicy: "final",
} satisfies Adapter.Config;

describe("GitHubAdapter channel-authn", () => {
  it("accepts valid HMAC signatures through channel-authn middleware", async () => {
    const decisions: ChannelAuthnDecision[] = [];
    const body = JSON.stringify({ action: "ignored" });
    const adapter = createAdapter(decisions);
    const request = new Request("http://localhost/github/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": await signGitHubBody(body),
        "x-github-event": "unknown",
      },
      body,
    });

    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Unsupported event");
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:github-hmac",
        policyId: "guardrail.permission",
        verdict: "allow",
        reason: "github signature verified",
      }),
    ]);
  });

  it("rejects invalid HMAC signatures through channel-authn middleware", async () => {
    const decisions: ChannelAuthnDecision[] = [];
    const adapter = createAdapter(decisions);
    const request = new Request("http://localhost/github/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=invalid" },
      body: JSON.stringify({ action: "ignored" }),
    });

    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:github-hmac",
        policyId: "guardrail.permission",
        verdict: "deny",
        reason: "github signature invalid",
      }),
    ]);
  });

  it("rejects missing HMAC signatures through channel-authn middleware", async () => {
    const decisions: ChannelAuthnDecision[] = [];
    const adapter = createAdapter(decisions);
    const request = new Request("http://localhost/github/webhook", {
      method: "POST",
      body: JSON.stringify({ action: "ignored" }),
    });

    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Missing signature");
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:github-hmac",
        policyId: "guardrail.permission",
        verdict: "deny",
        reason: "github signature missing",
      }),
    ]);
  });

  it("filters trigger-denied webhook content through channel-authn middleware", async () => {
    const decisions: ChannelAuthnDecision[] = [];
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 7,
        title: "Run work",
        labels: [{ name: "needs-triage" }],
        user: { login: "octocat", type: "User" },
      },
      comment: {
        id: 1,
        body: "@openomni run",
        user: { login: "octocat", type: "User" },
      },
      repository: {
        full_name: "openomni/project",
        owner: { login: "openomni" },
        name: "project",
      },
    });
    const adapter = createAdapter(decisions, {
      triggers: [
        { type: "event", events: ["issue_comment.created"] },
        { type: "label", values: ["approved"] },
      ],
      deliveryPolicy: "final",
    });
    const request = new Request("http://localhost/github/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": await signGitHubBody(body),
        "x-github-event": "issue_comment",
      },
      body,
    });

    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Filtered");
    expect(decisions).toEqual([
      expect.objectContaining({ name: "channel-authn:github-hmac", verdict: "allow" }),
      expect.objectContaining({
        name: "channel-authn:github-triggers",
        policyId: "guardrail.permission",
        verdict: "deny",
        reason: "github trigger denied",
        metadata: expect.objectContaining({
          surface: "github",
          event: "issue_comment.created",
          labels: ["needs-triage"],
        }),
      }),
    ]);
  });
});

function createAdapter(
  decisions: ChannelAuthnDecision[],
  adapterConfig: Adapter.Config = config,
): GitHubAdapter {
  return new GitHubAdapter(secret, adapterConfig, undefined, undefined, {
    onDecision: (decision) => {
      decisions.push(decision);
    },
  });
}

async function signGitHubBody(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
