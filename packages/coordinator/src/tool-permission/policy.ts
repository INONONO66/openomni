import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { Guardrail } from "@openomni/protocol";

const TOOL_CALL_ACTION = "tool.call";
const OVERRIDE_TOOL_FIELD = "__openomniCoordinatorTool";

const RISK_DEFAULTS: Record<string, "allow" | "deny"> = {
  echo: "allow",
  time: "allow",
  date: "allow",
  pwd: "allow",
  ls: "allow",
  cat: "allow",
  shell: "deny",
  bash: "deny",
  sh: "deny",
  exec: "deny",
  eval: "deny",
  rm: "deny",
  rmdir: "deny",
  curl: "deny",
  wget: "deny",
  nc: "deny",
};

const riskDefaultDenylist = Object.entries(RISK_DEFAULTS)
  .filter(([, decision]) => decision === "deny")
  .map(([tool]) => tool);

export type PermissionDecision = {
  allowed: boolean;
  reason: string;
  tier: "user-override" | "risk-default" | "unknown-default";
};

export type PolicyConfig = Partial<Guardrail.Permission> & {
  userOverrides?: Record<string, "allow" | "deny">;
};

export type PermissionRequestContext = {
  input?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  resourceMeta?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  riskTier?: number;
};

const DEFAULT_POLICY_PATH = join(homedir(), ".openomni", "tool-policy.json");

export function loadPolicy(path = DEFAULT_POLICY_PATH): PolicyConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PolicyConfig;
  } catch (error) {
    console.warn(
      `failed to load tool policy from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toOverrideRules(
  userOverrides: Record<string, "allow" | "deny"> | undefined,
): Guardrail.InputRule[] {
  return Object.entries(userOverrides ?? {}).map(([tool, decision]) => ({
    toolPattern: tool,
    field: OVERRIDE_TOOL_FIELD,
    pattern: `^${escapeRegex(tool)}$`,
    action: decision,
    reason: `user_override_${decision}`,
    priority: 10_000,
  }));
}

function normalizePolicy(policy: PolicyConfig, extraDenylist: string[] = []): Guardrail.Permission {
  const denylist = [...riskDefaultDenylist, ...(policy.denylist ?? []), ...extraDenylist];
  const inputRules = [...toOverrideRules(policy.userOverrides), ...(policy.inputRules ?? [])];

  return {
    action: policy.action ?? TOOL_CALL_ACTION,
    ...(policy.allowlist !== undefined ? { allowlist: policy.allowlist } : {}),
    ...(denylist.length > 0 ? { denylist } : {}),
    ...(policy.requireApproval !== undefined ? { requireApproval: policy.requireApproval } : {}),
    ...(inputRules.length > 0 ? { inputRules } : {}),
  };
}

function buildRequest(
  tool: string,
  context: PermissionRequestContext = {},
): Guardrail.EvaluationRequest {
  const input = { ...(context.input ?? {}), [OVERRIDE_TOOL_FIELD]: tool };
  const resourceMeta = {
    ...(context.resourceMeta ?? {}),
    ...(context.riskTier === undefined ? {} : { riskTier: context.riskTier }),
  };

  return {
    action: TOOL_CALL_ACTION,
    resource: tool,
    input,
    ...(context.actor !== undefined ? { actor: context.actor } : {}),
    ...(Object.keys(resourceMeta).length > 0 ? { resourceMeta } : {}),
    ...(context.metadata !== undefined ? { metadata: context.metadata } : {}),
  };
}

function evaluatePolicy(
  tool: string,
  policy: PolicyConfig,
  context: PermissionRequestContext,
): { result: Guardrail.EvaluationResult; tier?: PermissionDecision["tier"] } {
  const request = buildRequest(tool, context);
  const permission = normalizePolicy(policy);
  const result = Guardrail.evaluate(permission, request);

  if (result.reason !== "default_allow" || RISK_DEFAULTS[tool] !== undefined) {
    return { result };
  }

  if ((context.riskTier ?? 0) >= 2) {
    return {
      result: Guardrail.evaluate(normalizePolicy(policy, [tool]), request),
      tier: "unknown-default",
    };
  }

  return { result };
}

function decisionTier(tool: string, policy: PolicyConfig, result: Guardrail.EvaluationResult) {
  if (policy.userOverrides?.[tool] !== undefined) return "user-override";
  if (result.reason !== "default_allow" && RISK_DEFAULTS[tool] === undefined)
    return "user-override";
  if (RISK_DEFAULTS[tool] !== undefined) return "risk-default";
  return "unknown-default";
}

export function checkPermission(
  tool: string,
  policy: PolicyConfig,
  context: PermissionRequestContext = {},
): PermissionDecision {
  const { result, tier } = evaluatePolicy(tool, policy, context);
  return {
    allowed: result.action === "continue",
    reason: result.reason,
    tier: tier ?? decisionTier(tool, policy, result),
  };
}
