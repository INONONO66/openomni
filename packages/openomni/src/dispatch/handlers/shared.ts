import type { Command, Model } from "@openomni/protocol";
import { Session } from "@openomni/session";

// Inbound payload-text parsing is owned by ingress (the boundary that mints
// the payload shape): import extractText from ../../ingress/handlers.js.

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One session-creation policy for worker-spawning dispatch handlers: reuse
 * the command's target session, else create under the command's trace (child
 * when a parent is named). Byte-identical copies previously lived in
 * worker-spawn-payload and connector-endpoint-worker and were one edit away
 * from drifting.
 */
export function resolveWorkerSessionId(command: Command.Request, model: Model.Ref): string {
  if (command.target.sessionId) return command.target.sessionId;
  const title = `Dispatch worker ${command.action}`;
  const modelInfo = { providerID: model.provider, modelID: model.id };
  const session = command.target.parentSessionId
    ? Session.createChild({
        traceId: command.traceId,
        parentSessionId: command.target.parentSessionId,
        title,
        model: modelInfo,
      })
    : Session.create({ traceId: command.traceId, title, model: modelInfo });
  return session.id;
}
