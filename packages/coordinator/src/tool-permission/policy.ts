import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

// Unknown tools default to allow-with-audit because daemon mode cannot
// interactively prompt the user (AskEachTime deferred to future interactive mode).
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

export type PermissionDecision = {
  allowed: boolean;
  reason: string;
  tier: "user-override" | "risk-default" | "unknown-default";
};

export type PolicyConfig = {
  userOverrides?: Record<string, "allow" | "deny">;
  denylist?: string[];
  allowlist?: string[];
};

const DEFAULT_POLICY_PATH = join(homedir(), ".openomni", "tool-policy.json");

export function loadPolicy(path = DEFAULT_POLICY_PATH): PolicyConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PolicyConfig;
  } catch {
    return {};
  }
}

export function checkPermission(tool: string, policy: PolicyConfig): PermissionDecision {
  const userDecision = policy.userOverrides?.[tool];
  if (userDecision !== undefined) {
    return {
      allowed: userDecision === "allow",
      reason: `user override: ${userDecision}`,
      tier: "user-override",
    };
  }

  if (policy.denylist?.includes(tool)) {
    return { allowed: false, reason: "in denylist", tier: "user-override" };
  }
  if (policy.allowlist?.includes(tool)) {
    return { allowed: true, reason: "in allowlist", tier: "user-override" };
  }

  const riskDefault = RISK_DEFAULTS[tool];
  if (riskDefault !== undefined) {
    return {
      allowed: riskDefault === "allow",
      reason: `risk default: ${riskDefault}`,
      tier: "risk-default",
    };
  }

  return {
    allowed: true,
    reason: "unknown tool: allowed by default",
    tier: "unknown-default",
  };
}
