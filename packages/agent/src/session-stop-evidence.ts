import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { LedgerAction } from "@openomni/protocol";
import type { ChatAgentConfig } from "./core/types";
import type { ExecutionApprovals } from "./executor-contract";

/** Reads current committed obligations/effects; model prose cannot manufacture progress or waiting. */
export function sessionStopEvidence(
  sessionId: string,
  turnId: string,
  approvals: () => ExecutionApprovals | undefined,
  openIntent?: (input: {
    sessionId: string;
    turnId: string;
    revision: number;
  }) => Promise<readonly { actionId: string; kind: "message" | "approval" }[]>,
): NonNullable<ChatAgentConfig["stopEvidence"]> {
  let ordinal = SessionHandleStore.tree(sessionId).at(-1)?.ordinal ?? 0;
  return async () => {
    const actions = SessionHandleStore.tree(sessionId);
    const start = actions.find((action) => action.id === turnId)?.ordinal ?? ordinal;
    const recent = actions.filter((action) => action.ordinal > ordinal);
    ordinal = actions.at(-1)?.ordinal ?? ordinal;
    const obligations =
      (await openIntent?.({
        sessionId,
        turnId,
        revision: SessionHandleStore.row(sessionId).revision,
      })) ?? [];
    const pending = approvals()?.pending() ?? [];
    const armed = new Set(
      Storage.get()
        .alarms?.due(Number.MAX_SAFE_INTEGER)
        .map((alarm) => alarm.id) ?? [],
    );
    const alarmIds = actions
      .filter(
        (action) => action.ordinal > start && action.kind === "alarm.arm" && armed.has(action.id),
      )
      .map((action) => action.id);
    return {
      progress: recent.some(effectChanged),
      blocked: recent.some((action) => {
        const effect = action.effect.value;
        const intent = action.intent.value;
        if (
          action.kind === "policy.decision" &&
          intent !== null &&
          typeof intent === "object" &&
          !Array.isArray(intent) &&
          intent.verdict === "deny" &&
          (intent.hook === "tool.pre" || intent.hook === "tool.post")
        )
          return true;
        return (
          action.kind === "tool" &&
          effect !== null &&
          typeof effect === "object" &&
          !Array.isArray(effect) &&
          (effect.terminal === "blocked_pre" ||
            effect.terminal === "blocked_post" ||
            effect.terminal === "failed")
        );
      }),
      openIntent: [
        ...obligations.map((intent) => intent.actionId),
        ...pending.map((approval) => approval.id),
      ],
      alarmIds,
    };
  };
}

function effectChanged(action: LedgerAction.Node): boolean {
  if (
    action.kind === "session.configure" ||
    action.kind === "alarm.arm" ||
    action.kind === "inbox.deliver"
  )
    return true;
  const effect = action.effect.value;
  return (
    effect !== null &&
    typeof effect === "object" &&
    !Array.isArray(effect) &&
    effect.stateChanged === true
  );
}
