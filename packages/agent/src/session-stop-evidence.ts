import { Effect } from "effect";
import type { LedgerAction } from "@openomni/protocol";
import type { SessionKernel } from "./cluster/kernel-registry";
import type { SessionRuntime } from "./session-contract";
import type { ChatAgentConfig } from "./core/types";
import type { ExecutionApprovals } from "./executor-contract";

export function sessionStopEvidence(
  kernel: SessionKernel,
  sessionId: string,
  turnId: string,
  approvals: () => ExecutionApprovals | undefined,
  openIntent?: SessionRuntime["openIntent"],
): NonNullable<ChatAgentConfig["stopEvidence"]> {
  let ordinal = kernel.row(sessionId).revision;
  const start = kernel.actionById(turnId)?.ordinal ?? ordinal;
  return () => Effect.gen(function* () {
    const revision = kernel.row(sessionId).revision;
    let progress = false;
    let blocked = false;
    while (ordinal < revision) {
      const page = kernel.historyPage(sessionId, { afterRevision: ordinal, limit: 256 });
      for (const action of page.actions) {
        if (action.ordinal > revision) break;
        progress ||= effectChanged(action);
        blocked ||= effectBlocked(action);
        ordinal = action.ordinal;
      }
    }
    const obligations = yield* (openIntent?.({ sessionId, turnId, revision }) ?? Effect.succeed([]));
    const pending = approvals()?.pending() ?? [];
    return {
      progress, blocked,
      openIntent: [...obligations.map((intent) => intent.actionId), ...pending.map((approval) => approval.id)],
      alarmIds: openAlarmIds(kernel, sessionId, start, revision),
    };
  });
}

/**
 * Live wait evidence is a chain fold (the alarm table is gone): every
 * `alarm.arm` action committed after this turn opened whose alarm no later
 * `alarm.fired`/`alarm.paused` child settled is still armed.
 */
function openAlarmIds(
  kernel: SessionKernel,
  sessionId: string,
  start: number,
  revision: number,
): string[] {
  const armed = new Map<string, string>();
  let cursor = start;
  while (cursor < revision) {
    const page = kernel.historyPage(sessionId, { afterRevision: cursor, limit: 256 });
    for (const action of page.actions) {
      if (action.ordinal > revision) break;
      if (action.kind === "alarm.arm") armed.set(action.id, action.id);
      if ((action.kind === "alarm.fired" || action.kind === "alarm.paused") && action.parentId !== null)
        armed.delete(action.parentId);
      cursor = action.ordinal;
    }
    if (page.nextRevision === null) break;
  }
  return [...armed.keys()];
}

function effectBlocked(action: LedgerAction.Node): boolean {
  const effect = action.effect.value;
  const intent = action.intent.value;
  if (action.kind === "policy.decision" && intent !== null && typeof intent === "object" && !Array.isArray(intent) && intent.verdict === "deny" && (intent.hook === "tool.pre" || intent.hook === "tool.post")) return true;
  return action.kind === "tool" && effect !== null && typeof effect === "object" && !Array.isArray(effect) && (effect.terminal === "blocked_pre" || effect.terminal === "blocked_post" || effect.terminal === "failed");
}

function effectChanged(action: LedgerAction.Node): boolean {
  if (action.kind === "session.configure" || action.kind === "alarm.arm" || action.kind === "inbox.deliver") return true;
  const effect = action.effect.value;
  return effect !== null && typeof effect === "object" && !Array.isArray(effect) && effect.stateChanged === true;
}
