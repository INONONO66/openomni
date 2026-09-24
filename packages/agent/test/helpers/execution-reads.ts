import { SessionHandleStore } from "@openomni/ledger";
import { PlainObjectSchema, SessionTransition, type LedgerAction } from "@openomni/protocol";
import type { ExecutionLedger } from "../../src/executor-contract";

type Reads = Omit<ExecutionLedger, "commit" | "transition" | "validateRequest">;

export function executionReads(sessionId: string): Reads {
  return {
    actionById: SessionHandleStore.actionById,
    requestById: SessionHandleStore.requestById,
    resultFor: (id) => SessionHandleStore.resultFor(sessionId, id),
    openOperationsPage: (id, cursor) =>
      SessionHandleStore.openOperationsPage(sessionId, id, cursor),
    operationChildrenPage: (id, cursor) =>
      SessionHandleStore.operationChildrenPage(sessionId, id, cursor),
    guardedOperationsPage: (id, cursor) =>
      SessionHandleStore.guardedOperationsPage(sessionId, id, cursor),
  };
}

/** Independent in-memory oracle for executor-only tests, with the same bounded port semantics. */
export function memoryExecutionReads(read: () => readonly LedgerAction.Node[]): Reads {
  const intent = (action: LedgerAction.Node) => PlainObjectSchema.parse(action.intent.value);
  const resultFor = (id: string) =>
    read().find(
      (action) =>
        action.parentId === id &&
        action.kind !== "fold.checkpoint" &&
        PlainObjectSchema.parse(action.effect.value).phase === "result",
    );
  const page = (actions: readonly LedgerAction.Node[], cursor: number) =>
    actions.filter((action) => action.ordinal > cursor).slice(0, 256);
  const guarded = (turnId: string) =>
    new Set(
      read()
        .filter(
          (action) => intent(action).turnId === turnId && intent(action).approvalRequired === true,
        )
        .map((action) => intent(action).waveId),
    );
  return {
    actionById: (id) => read().find((action) => action.id === id),
    requestById: (id) =>
      read()
        .flatMap((action) => {
          const request = SessionTransition.Request.safeParse(
            PlainObjectSchema.parse(action.effect.value).request,
          );
          return request.success && request.data.requestId === id ? [request.data] : [];
        })
        .at(-1),
    resultFor,
    operationChildrenPage: (id, cursor) =>
      page(
        read().filter((action) => action.parentId === id),
        cursor,
      ),
    openOperationsPage: (turnId, cursor) => {
      const parents = new Set([
        turnId,
        ...read()
          .filter(
            (action) =>
              action.kind === "turn" &&
              intent(action).phase === "resume" &&
              intent(action).turnId === turnId,
          )
          .map((action) => action.id),
      ]);
      return page(
        read().filter(
          (action) =>
            intent(action).phase === "intent" &&
            resultFor(action.id) === undefined &&
            (action.kind === "tool"
              ? intent(action).turnId === turnId && !guarded(turnId).has(intent(action).waveId)
              : ["llm", "message", "compaction"].includes(action.kind) &&
                parents.has(action.parentId ?? "")),
        ),
        cursor,
      );
    },
    guardedOperationsPage: (turnId, cursor) => {
      const members = read().filter(
        (action) =>
          action.kind === "tool" &&
          intent(action).phase === "intent" &&
          guarded(turnId).has(intent(action).waveId),
      );
      const unfinished = new Set(
        members
          .filter((action) => resultFor(action.id) === undefined)
          .map((action) => intent(action).waveId),
      );
      const ids = new Set(
        members
          .filter((action) => unfinished.has(intent(action).waveId))
          .map((action) => action.id),
      );
      return page(
        read().filter((action) => ids.has(action.id) || ids.has(action.parentId ?? "")),
        cursor,
      );
    },
  };
}
