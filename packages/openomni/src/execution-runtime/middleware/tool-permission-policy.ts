import type { BusEvent } from "@openomni/protocol";
import { Operational, Policy, PolicyDecision } from "@openomni/protocol";
import { decisionFromEvaluation, evaluatePermission } from "@openomni/policy";
import { z } from "zod";
import type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyRegistryInstance,
} from "@openomni/agent";

const TOOL_CALL_ACTION = "tool.call";

export interface ToolPermissionPolicyConfig {
  permission: Policy.Permission;
  /** Where a failed evaluation is reported. The guard denies; it does not decide where. */
  events: BusEvent.Sink;
}

/**
 * The trace this guard reports under. A permission evaluation happens inside
 * a tool call, which happens inside a run — the guard is never an origin.
 */
function requireGuardTraceId(ctx: {
  readonly traceContext?: { readonly traceId?: string };
}): string {
  const traceId = ctx.traceContext?.traceId;
  if (traceId === undefined || traceId.length === 0) {
    throw new Error("tool permission guard requires the run trace context");
  }
  return traceId;
}

export function createToolPermissionPolicy(
  config: ToolPermissionPolicyConfig,
): CanonicalPolicyRegistration {
  return {
    name: "builtin:tool-permission",
    kind: "point",
    pointIds: ["tool.native.pre", "tool.mcp.pre"],
    effectCapabilities: {
      "tool.native.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
      "tool.mcp.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
    },
    priority: 0,
    failPolicy: "fail-closed",
    fn: async (ctx) => {
      const toolName = ctx.toolName;
      const toolInput = ctx.toolInput;
      // A tool point without a tool name is a malformed context, not a free
      // pass: inside a fail-closed guard the unidentifiable call denies and
      // aborts the run (audit batch A — the `!toolName → allow` arm was the
      // one input an adversary controls end-to-end).
      if (!toolName) {
        return PolicyDecision.deny({
          policyId: "guardrail.permission",
          reasonCodes: ["tool_permission_missing_tool_name"],
          effects: [{ type: "run.abort", reason: "tool_permission_missing_tool_name" }],
        });
      }

      const normalizedPermission: Policy.Permission = config.permission.action
        ? config.permission
        : { ...config.permission, action: TOOL_CALL_ACTION };

      let verdict: Policy.EvaluationResult;
      try {
        verdict = evaluatePermission(normalizedPermission, {
          action: TOOL_CALL_ACTION,
          resource: toolName,
          resourceLabels: ctx.toolLabels,
          input: toolInput ?? {},
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        config.events.publish(Operational.Events.Debug, {
          traceId: requireGuardTraceId(ctx),
          time: Date.now(),
          component: "agent.policy.tool-permission",
          msg: "tool permission evaluation failed",
          context: { toolName, error: errorMessage },
        });
        return PolicyDecision.deny({
          policyId: "guardrail.permission",
          reasonCodes: ["tool_permission_evaluation_failed"],
          effects: [{ type: "run.abort", reason: "tool_permission_evaluation_failed" }],
        });
      }

      // The verdict carries the outcome: `require_approval` composes to a
      // `pending` decision, which `PolicyDecision.isBlocking` treats as
      // blocking, so the tool executor never runs the call.
      return decisionFromEvaluation(verdict);
    },
  };
}

/**
 * Wire shape only: the output type omits `events`, and a plain `z.object`
 * strips what the shape does not name. A policy plan therefore cannot smuggle
 * a sink of its own and redirect where the evidence of its own decision goes.
 */
const ToolPermissionConfigSchema: z.ZodType<
  Omit<ToolPermissionPolicyConfig, "events">,
  z.ZodTypeDef,
  unknown
> = z.object({ permission: Policy.Permission });

/**
 * Registers the tool permission guard. A permission ruleset is an opinion
 * about what an agent may touch, which is a product's to hold (D5); the core
 * ships the fail-closed point it hangs on.
 *
 * @param events Where the guard's evaluation failures go. Passed in rather
 * than reached for, and spread last so a plan cannot redirect it.
 */
export function registerToolPermission(
  registry: PolicyRegistryInstance<PolicyContext>,
  events: BusEvent.Sink,
): void {
  registry.register("builtin:tool-permission", (config) =>
    createToolPermissionPolicy({
      ...ToolPermissionConfigSchema.parse(
        // Absent config fails CLOSED (audit batch A): a plan that selects the
        // guard without owning a ruleset denies every tool — an explicit
        // ruleset comes from the plan config or the gate's resolver stamp,
        // never from an implicit allow-all default here.
        config === undefined ? { permission: { action: "tool.call", denylist: ["*"] } } : config,
      ),
      events,
    }),
  );
}
