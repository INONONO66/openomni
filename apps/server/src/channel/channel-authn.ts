import { Policy, type Adapter } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { evaluateTriggers } from "../shared/trigger";
import { verifyGitHubSignature } from "./github/webhook";

type ChannelAuthnPolicyId = string;

export interface ChannelAuthnDecision {
  readonly timing: Policy.Timing;
  readonly name: string;
  readonly policyId: ChannelAuthnPolicyId;
  readonly verdict: Policy.Verdict["action"];
  readonly reason: string;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
}

export type ChannelAuthnDecisionObserver = (decision: ChannelAuthnDecision) => void | Promise<void>;

export interface WebSocketAuthResult {
  readonly verdict: Policy.Verdict;
  readonly headers?: Record<string, string>;
  readonly response?: Response;
}

export interface GitHubAuthResult {
  readonly verdict: Policy.Verdict;
  readonly body?: string;
  readonly response?: Response;
}

export interface ChannelTriggerAuthResult {
  readonly verdict: Policy.Verdict;
}

interface WebSocketAuthState {
  readonly request: Request;
  readonly token?: string;
  headers?: Record<string, string>;
  response?: Response;
}

interface GitHubAuthState {
  readonly request: Request;
  readonly secret: string;
  body?: string;
  response?: Response;
}

const authTiming: Policy.Timing = "pre_run";

function evaluateChannelPermission(input: {
  readonly action: ChannelAuthnPolicyId;
  readonly resource: string;
  readonly field: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
  readonly metadata?: Record<string, unknown>;
}): Policy.Verdict {
  const request: Policy.EvaluationRequest = {
    action: input.action,
    resource: input.resource,
    input: { [input.field]: String(input.allowed) },
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  return Policy.evaluate(
    {
      action: input.action,
      inputRules: [
        {
          toolPattern: input.resource,
          field: input.field,
          pattern: "^true$",
          action: "allow",
          reason: input.allowReason,
          priority: 2,
        },
        {
          toolPattern: input.resource,
          field: input.field,
          pattern: "^false$",
          action: "deny",
          reason: input.denyReason,
          priority: 1,
        },
      ],
    },
    request,
  );
}

function triggerMetadata(input: {
  readonly surface: string;
  readonly rules: Adapter.TriggerRule[];
  readonly ctx: Adapter.TriggerContext;
}): Record<string, unknown> {
  return {
    surface: input.surface,
    event: input.ctx.event,
    channelId: input.ctx.channelId,
    senderId: input.ctx.senderId,
    mentioned: input.ctx.mentioned,
    isDM: input.ctx.isDM ?? false,
    labels: input.ctx.labels ?? [],
    triggerRuleCount: input.rules.length,
  };
}

function evaluateChannelTriggers(input: {
  readonly definition: Policy.Definition;
  readonly policyId: ChannelAuthnPolicyId;
  readonly surface: string;
  readonly resource: string;
  readonly rules: Adapter.TriggerRule[];
  readonly ctx: Adapter.TriggerContext;
  readonly onDecision?: ChannelAuthnDecisionObserver;
}): ChannelTriggerAuthResult {
  const startedAt = Date.now();
  const metadata = triggerMetadata({ surface: input.surface, rules: input.rules, ctx: input.ctx });
  const verdict = evaluateChannelPermission({
    action: input.policyId,
    resource: input.resource,
    field: "triggered",
    allowed: evaluateTriggers(input.rules, input.ctx),
    allowReason: `${input.surface} trigger accepted`,
    denyReason: `${input.surface} trigger denied`,
    metadata,
  });
  void recordDecision(
    input.definition,
    verdict,
    Date.now() - startedAt,
    input.onDecision,
    metadata,
  );

  return { verdict };
}

function readSubprotocolAuth(
  req: Request,
): { readonly token: string; readonly selected: string } | undefined {
  const header = req.headers.get("sec-websocket-protocol");
  const protocols = header
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  if (!protocols) return undefined;

  const authIndex = protocols.indexOf("auth");
  const token = authIndex >= 0 ? protocols[authIndex + 1] : undefined;
  return token ? { token, selected: "auth" } : undefined;
}

function recordDecision(
  definition: Policy.Definition,
  verdict: Policy.Verdict,
  durationMs: number,
  onDecision: ChannelAuthnDecisionObserver | undefined,
  metadata?: Record<string, unknown>,
): void | Promise<void> {
  return onDecision?.({
    timing: authTiming,
    name: definition.name,
    policyId: verdict.policyId ?? "guardrail.permission",
    verdict: verdict.action,
    reason: verdict.reason ?? "unspecified",
    durationMs,
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

function evaluateWebSocketToken(state: WebSocketAuthState): Policy.Verdict {
  const policyId = "channel.authn.websocket-token";
  if (!state.token) {
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: true,
      allowReason: "websocket token auth not configured",
      denyReason: "websocket token missing or invalid",
    });
  }

  const url = new URL(state.request.url);
  const subprotocolAuth = readSubprotocolAuth(state.request);
  const provided = subprotocolAuth?.token ?? url.searchParams.get("token");
  if (provided !== state.token) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "websocket auth failure",
    });
    state.response = new Response("Unauthorized", { status: 401 });
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: false,
      allowReason: "websocket token accepted",
      denyReason: "websocket token missing or invalid",
    });
  }

  if (subprotocolAuth) {
    state.headers = { "Sec-WebSocket-Protocol": subprotocolAuth.selected };
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: true,
      allowReason: "websocket subprotocol token accepted",
      denyReason: "websocket token missing or invalid",
    });
  }

  Bus.publish(Operational.Warn, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "websocket query token auth is deprecated",
  });
  return evaluateChannelPermission({
    action: policyId,
    resource: "websocket.upgrade",
    field: "authenticated",
    allowed: true,
    allowReason: "websocket query token accepted",
    denyReason: "websocket token missing or invalid",
  });
}

async function evaluateGitHubHmac(state: GitHubAuthState): Promise<Policy.Verdict> {
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

export namespace ChannelAuthnMiddleware {
  export const WebSocketToken = {
    name: "channel-authn:websocket-token",
    timing: authTiming,
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Policy.Definition;

  export const GitHubHmac = {
    name: "channel-authn:github-hmac",
    timing: authTiming,
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Policy.Definition;

  export const DiscordTriggers = {
    name: "channel-authn:discord-triggers",
    timing: authTiming,
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Policy.Definition;

  export const TelegramTriggers = {
    name: "channel-authn:telegram-triggers",
    timing: authTiming,
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Policy.Definition;

  export const GitHubTriggers = {
    name: "channel-authn:github-triggers",
    timing: authTiming,
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Policy.Definition;

  export function authenticateDiscordTriggers(input: {
    readonly triggers: Adapter.TriggerRule[];
    readonly ctx: Adapter.TriggerContext;
    readonly onDecision?: ChannelAuthnDecisionObserver;
  }): ChannelTriggerAuthResult {
    return evaluateChannelTriggers({
      definition: DiscordTriggers,
      policyId: "channel.authn.discord-triggers",
      surface: "discord",
      resource: "discord.message",
      rules: input.triggers,
      ctx: input.ctx,
      ...(input.onDecision !== undefined ? { onDecision: input.onDecision } : {}),
    });
  }

  export function authenticateTelegramTriggers(input: {
    readonly triggers: Adapter.TriggerRule[];
    readonly ctx: Adapter.TriggerContext;
    readonly onDecision?: ChannelAuthnDecisionObserver;
  }): ChannelTriggerAuthResult {
    return evaluateChannelTriggers({
      definition: TelegramTriggers,
      policyId: "channel.authn.telegram-triggers",
      surface: "telegram",
      resource: "telegram.message",
      rules: input.triggers,
      ctx: input.ctx,
      ...(input.onDecision !== undefined ? { onDecision: input.onDecision } : {}),
    });
  }

  export function authenticateGitHubTriggers(input: {
    readonly triggers: Adapter.TriggerRule[];
    readonly ctx: Adapter.TriggerContext;
    readonly onDecision?: ChannelAuthnDecisionObserver;
  }): ChannelTriggerAuthResult {
    return evaluateChannelTriggers({
      definition: GitHubTriggers,
      policyId: "channel.authn.github-triggers",
      surface: "github",
      resource: `github.${input.ctx.event}`,
      rules: input.triggers,
      ctx: input.ctx,
      ...(input.onDecision !== undefined ? { onDecision: input.onDecision } : {}),
    });
  }

  export function authenticateWebSocketUpgrade(input: {
    readonly request: Request;
    readonly token?: string;
    readonly onDecision?: ChannelAuthnDecisionObserver;
  }): WebSocketAuthResult {
    const startedAt = Date.now();
    const state: WebSocketAuthState = {
      request: input.request,
      ...(input.token !== undefined ? { token: input.token } : {}),
    };
    const verdict = evaluateWebSocketToken(state);
    void recordDecision(WebSocketToken, verdict, Date.now() - startedAt, input.onDecision);

    return {
      verdict,
      ...(state.headers !== undefined ? { headers: state.headers } : {}),
      ...(state.response !== undefined ? { response: state.response } : {}),
    };
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
}
