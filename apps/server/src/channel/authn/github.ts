import type { Policy } from "@openomni/protocol";
import { GitHubHmac } from "./definitions";
import { evaluateChannelPermission, recordDecision } from "./decision";
import type { ChannelAuthnDecisionObserver, GitHubAuthResult } from "./types";
import { verifyGitHubSignature } from "../github/webhook";

interface GitHubAuthState {
  readonly request: Request;
  readonly secret: string;
  body?: string;
  response?: Response;
}

async function evaluateGitHubHmac(state: GitHubAuthState): Promise<Policy.PolicyDecision> {
  const policyId = "channel.authn.github-hmac";
  const signature = state.request.headers.get("x-hub-signature-256");
  if (!signature) {
    state.response = new Response("Missing signature", { status: 401 });
    return evaluateChannelPermission({
      action: policyId,
      resource: "github.webhook",
      field: "authenticated",
      allowed: false,
      allowReason: "github signature verified",
      denyReason: "github signature missing",
    });
  }

  const body = await state.request.text();
  state.body = body;
  if (!(await verifyGitHubSignature(body, signature, state.secret))) {
    state.response = new Response("Invalid signature", { status: 401 });
    return evaluateChannelPermission({
      action: policyId,
      resource: "github.webhook",
      field: "authenticated",
      allowed: false,
      allowReason: "github signature verified",
      denyReason: "github signature invalid",
    });
  }

  return evaluateChannelPermission({
    action: policyId,
    resource: "github.webhook",
    field: "authenticated",
    allowed: true,
    allowReason: "github signature verified",
    denyReason: "github signature invalid",
  });
}

export async function authenticateGitHubWebhook(input: {
  readonly request: Request;
  readonly secret: string;
  readonly onDecision?: ChannelAuthnDecisionObserver;
}): Promise<GitHubAuthResult> {
  const startedAt = Date.now();
  const state: GitHubAuthState = {
    request: input.request,
    secret: input.secret,
  };
  const verdict = await evaluateGitHubHmac(state);
  await recordDecision(GitHubHmac, verdict, Date.now() - startedAt, input.onDecision);

  return {
    verdict,
    ...(state.body !== undefined ? { body: state.body } : {}),
    ...(state.response !== undefined ? { response: state.response } : {}),
  };
}
