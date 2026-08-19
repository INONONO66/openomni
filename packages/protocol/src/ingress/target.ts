import { Ingress } from "./index.js";

/**
 * Pure target resolution over the Ingress vocabulary (#707 hoist): both
 * planes (ingress routing and brain-side projection/authority labels) fold
 * the same explicit-target > meta-target > resident-default precedence and
 * the same stable target key. No store access, no defaulting judgment —
 * absent targets are a protocol fact (resident), not a routing decision.
 */
export function resolveTarget(event: {
  target?: Ingress.Target;
  meta?: { target?: Ingress.Target };
}): Ingress.Target {
  if (event.target) return Ingress.TargetSchema.parse(event.target);
  if (event.meta?.target) return Ingress.TargetSchema.parse(event.meta.target);
  return { kind: "resident" };
}

export function targetKey(target: Ingress.Target): string {
  if (target.kind === "resident") {
    return target.sessionId ? `resident:${target.sessionId}` : "resident";
  }
  if (target.sessionId) return `worker-session:${target.sessionId}`;
  return target.workerId ? `worker:${target.workerId}` : "worker";
}
