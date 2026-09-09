import { expect, it } from "bun:test";
import type { ChannelAuthnDecisionObserver } from "../src/authn/types";
import { GitHubAdapter } from "../src/provider/github/surface";
import { signGitHubBody } from "./helpers/github";

type ChannelAuthnDecision = Parameters<ChannelAuthnDecisionObserver>[0];
const secret = "github-webhook-secret";

it.each([
  { signature: "valid", status: 200, verdict: "allow" },
  { signature: "invalid", status: 401, verdict: "deny" },
  { signature: "missing", status: 401, verdict: "deny" },
] as const)("GitHub $signature HMAC produces $status and $verdict", async ({
  signature,
  status,
  verdict,
}) => {
  const decisions: ChannelAuthnDecision[] = [];
  const adapter = new GitHubAdapter(secret, {}, () => undefined, undefined, {
    onDecision: (decision) => {
      decisions.push(decision);
    },
  });
  adapter.onMessage(async () => undefined);
  const body = JSON.stringify({ action: "ignored" });
  const headers = new Headers({ "x-github-event": "unknown" });
  if (signature !== "missing")
    headers.set(
      "x-hub-signature-256",
      signature === "valid" ? signGitHubBody(body, secret) : "sha256=invalid",
    );
  const response = await adapter.handleWebhook(
    new Request("http://localhost/github/webhook", {
      method: "POST",
      headers,
      body,
    }),
  );
  expect(response.status).toBe(status);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    name: "channel-authn:github-hmac",
    policyId: "guardrail.permission",
    verdict,
  });
});
