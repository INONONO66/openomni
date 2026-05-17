import { Ingress } from "@openomni/protocol";

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
