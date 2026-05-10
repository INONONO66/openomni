import { Guardrail, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

const TOOL_CALL_ACTION = "tool.call";

function normalizePermission(permission: Guardrail.Permission): Guardrail.Permission {
  if (permission.action) return permission;
  return { ...permission, action: TOOL_CALL_ACTION };
}

function toLegacyDecision(
  result: Guardrail.EvaluationResult,
): "allow" | "deny" | "require_approval" {
  if (result.decision !== undefined) return result.decision;
  return result.action === "continue" ? "allow" : "deny";
}

function logDecision(toolName: string, result: Guardrail.EvaluationResult): void {
  const fields = { toolName, reason: result.reason, matchedPattern: result.matchedPattern };
  if (result.action === "abort") {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "agent.tool-guard",
      msg: "guardrail: tool blocked",
      context: fields,
    });
    return;
  }
  Bus.publish(Operational.Debug, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "agent.tool-guard",
    msg: "guardrail: tool allowed",
    context: fields,
  });
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
