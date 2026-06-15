import { IngressEvent, type Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { HandlerContext } from "./handler-types";
import { resolveTarget } from "./target";

export function summarizeTarget(event: Ingress.ResolvedInboundEvent): string | undefined {
  return resolveTarget(event).kind;
}

export function publishModeDetected(ctx: HandlerContext, target: string | undefined): void {
  if (!ctx.traceContext) return;
  Bus.publish(IngressEvent.ModeDetected, {
    traceId: ctx.traceContext.traceId,
    sessionId: ctx.sessionId,
    mode: ctx.event.mode,
    ...(target ? { target } : {}),
    time: Date.now(),
  });
}

export function publishCompleted(
  ctx: HandlerContext,
  target: string | undefined,
  start: number,
): void {
  if (!ctx.traceContext) return;
  Bus.publish(IngressEvent.Completed, {
    traceId: ctx.traceContext.traceId,
    sessionId: ctx.sessionId,
    mode: ctx.event.mode,
    ...(target ? { target } : {}),
    durationMs: Date.now() - start,
    time: Date.now(),
  });
}

export function publishFailed(
  ctx: HandlerContext,
  target: string | undefined,
  start: number,
  error: unknown,
): void {
  if (!ctx.traceContext) return;
  const message = error instanceof Error ? error.message : String(error);
  Bus.publish(IngressEvent.Failed, {
    traceId: ctx.traceContext.traceId,
    sessionId: ctx.sessionId,
    mode: ctx.event.mode,
    ...(target ? { target } : {}),
    durationMs: Date.now() - start,
    error: message,
    time: Date.now(),
  });
}
