import { Effect } from "effect";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { LedgerAction } from "@openomni/protocol";
import type { SessionRuntime } from "./session-contract";
import type { ChatAgentConfig } from "./core/types";
import type { ExecutionApprovals } from "./executor-contract";

export function sessionStopEvidence(
  sessionId: string,
  turnId: string,
  approvals: () => ExecutionApprovals | undefined,
  openIntent?: SessionRuntime["openIntent"],
): NonNullable<ChatAgentConfig["stopEvidence"]> {
  let ordinal = SessionHandleStore.row(sessionId).revision;
  const start = SessionHandleStore.actionById(turnId)?.ordinal ?? ordinal;
  return () => Effect.gen(function* () {
    const revision = SessionHandleStore.row(sessionId).revision;
    let progress = false;
    let blocked = false;
    while (ordinal < revision) {
      const page = SessionHandleStore.historyPage(sessionId, { afterRevision: ordinal, limit: 256 });
      for (const action of page.actions) {
        if (action.ordinal > revision) break;
        progress ||= effectChanged(action);
        blocked ||= effectBlocked(action);
        ordinal = action.ordinal;
      }
    }
    const obligations = yield* (openIntent?.({ sessionId, turnId, revision }) ?? Effect.succeed([]));
    const pending = approvals()?.pending() ?? [];
    const alarms = Storage.get().alarms?.due(Number.MAX_SAFE_INTEGER) ?? [];
    const alarmIds = alarms.flatMap((alarm) => {
      const action = SessionHandleStore.actionById(alarm.id);
      return action?.sessionId === sessionId && action.ordinal > start ? [alarm.id] : [];
    });
    return {
      progress, blocked,
      openIntent: [...obligations.map((intent) => intent.actionId), ...pending.map((approval) => approval.id)],
      alarmIds,
    };
  });
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
