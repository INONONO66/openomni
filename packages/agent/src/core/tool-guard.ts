import { Guardrail } from "@openomni/protocol";
import { Log } from "@openomni/session";

const TOOL_CALL_ACTION = "tool.call";

function normalizePermission(permission: Guardrail.Permission): Guardrail.Permission {
  if (permission.action) return permission;
  return { ...permission, action: TOOL_CALL_ACTION };
}

function toLegacyDecision(
  result: Guardrail.EvaluationResult,
): "allow" | "deny" | "require_approval" {
  if (result.action === "continue") return "allow";
  if (result.reason === "require_approval" || result.reason === "input_rule_require_approval") {
    return "require_approval";
  }
  return "deny";
}

function logDecision(toolName: string, result: Guardrail.EvaluationResult): void {
  const fields = { toolName, reason: result.reason, matchedPattern: result.matchedPattern };
  if (result.action === "abort") {
    Log.warn("guardrail: tool blocked", fields);
    return;
  }
  Log.debug("guardrail: tool allowed", fields);
}

export namespace ToolGuard {
  export function evaluate(
    toolName: string,
    input: Record<string, unknown>,
    permission: Guardrail.Permission,
  ): Guardrail.EvaluationResult {
    const result = Guardrail.evaluate(normalizePermission(permission), {
      action: TOOL_CALL_ACTION,
      resource: toolName,
      input,
    });
    logDecision(toolName, result);
    return result;
  }

  export function check(
    toolName: string,
    input: Record<string, unknown>,
    permission: Guardrail.Permission,
  ): "allow" | "deny" | "require_approval" {
    const result = evaluate(toolName, input, permission);
    return toLegacyDecision(result);
  }
}
