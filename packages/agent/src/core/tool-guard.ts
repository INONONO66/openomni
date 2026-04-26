import type { Guardrail } from "@openomni/protocol";
import { Log } from "@openomni/session";

const MAX_REGEX_PATTERN_LENGTH = 200;
const MAX_INPUT_LENGTH = 10_000;

function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(`${pattern.slice(0, -2)}.`);
  return toolName === pattern;
}

function matchInputField(input: Record<string, unknown>, field: string, pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;

  const raw = String(input[field] ?? "");
  const value = raw.length > MAX_INPUT_LENGTH ? raw.slice(0, MAX_INPUT_LENGTH) : raw;

  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

export namespace ToolGuard {
  export function check(
    toolName: string,
    input: Record<string, unknown>,
    permission: Guardrail.ToolPermission,
  ): "allow" | "deny" | "require_approval" {
    // 1. InputRules (highest priority)
    const inputRules = permission.inputRules ?? [];
    if (inputRules.length > 0) {
      const sorted = [...inputRules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      for (const rule of sorted) {
        if (
          matchToolPattern(toolName, rule.toolPattern) &&
          matchInputField(input, rule.field, rule.pattern)
        ) {
          Log.warn("guardrail: input rule matched", {
            toolName,
            action: rule.action,
            field: rule.field,
          });
          return rule.action;
        }
      }
    }
    // 2. Fall through to existing tool-level logic
    if (permission.denylist?.includes(toolName)) {
      Log.warn("guardrail: tool denied by denylist", { toolName });
      return "deny";
    }
    if (permission.requireApproval?.includes(toolName)) {
      Log.warn("guardrail: tool requires approval", { toolName });
      return "require_approval";
    }
    if (permission.allowlist !== undefined) {
      if (permission.allowlist.length === 0) {
        Log.warn("guardrail: tool denied by empty allowlist", { toolName });
        return "deny";
      }
      if (permission.allowlist.includes("*")) {
        Log.debug("guardrail: tool allowed by wildcard", { toolName });
        return "allow";
      }
      const prefixMatch = permission.allowlist.some(
        (p: string) => p.endsWith(".*") && toolName.startsWith(p.slice(0, -1)),
      );
      if (prefixMatch) {
        Log.debug("guardrail: tool allowed by prefix match", { toolName });
        return "allow";
      }
      if (permission.allowlist.includes(toolName)) {
        Log.debug("guardrail: tool allowed by allowlist", { toolName });
        return "allow";
      }
      Log.warn("guardrail: tool denied by allowlist", { toolName });
      return "deny";
    }
    Log.debug("guardrail: tool allowed by default", { toolName });
    return "allow";
  }
}
