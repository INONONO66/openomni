import { Effect, Either } from "effect";
import { type LedgerSession, type SessionGeneration, SessionTurn } from "@openomni/protocol";
import { SessionHandleStore } from "../src/index";
import { materializeSession } from "../test/helpers/session";

/** Populate two committed turn actions per turn through the fenced L0 commit. */
export function seedTurnHistory(id: string, count = 10): void {
  materializeSession(id);
  const tree = SessionHandleStore.tree(id);
  const generation = SessionHandleStore.latestGeneration(tree);
  let parentId = tree.at(-1)?.id ?? null;
  for (let index = 0; index < count; index += 1) {
    const request = prepareTurnCommit(id, index, parentId, generation);
    Either.getOrThrowWith(Effect.runSync(Effect.either(SessionHandleStore.commit(request))), (error) => error);
    parentId = request.actions.at(-1)?.id ?? null;
  }
}

/** Lease acquisition and payload construction belong outside commit timing. */
export function prepareTurnCommit(
  id: string,
  index: number,
  parentId: string | null,
  generation: SessionGeneration.Snapshot,
): LedgerSession.Commit {
  const row = SessionHandleStore.row(id);
  const turnId = `${id}:turn:${index}`;
  const resultId = `${turnId}:result`;
  const now = index + 2;
  const lease = Either.getOrThrowWith(Effect.runSync(Effect.either(SessionHandleStore.acquireLease({
    sessionId: id,
    owner: "bench",
    expectedFence: row.leaseFence,
    now,
    expiresAt: now + 100,
  }))), (error) => error);
  return {
    sessionId: id,
    owner: "bench",
    fence: lease.fence,
    now,
    expectedRevision: row.revision,
    consumeInboxIds: [],
    state: "idle",
    releaseLease: true,
    actions: [
      {
        id: turnId,
        sessionId: id,
        parentId,
        kind: "turn",
        ts: now,
        irreversible: true,
        intent: {
          encodingVersion: 1,
          value: SessionTurn.Intent.parse({
            phase: "intent",
            resultId,
            inboxIds: [],
            resumeCount: 0,
            boundaryActionId: null,
            toolsGeneration: generation.generation,
            toolsHash: generation.toolsHash,
            systemHash: generation.systemHash,
            policyGeneration: generation.policyGeneration,
          }),
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
      },
      {
        id: resultId,
        sessionId: id,
        parentId: turnId,
        kind: "turn",
        ts: now,
        irreversible: true,
        intent: {
          encodingVersion: 1,
          value: SessionTurn.TerminalIntent.parse({ phase: "terminal", turnId }),
        },
        effect: {
          encodingVersion: 1,
          value: SessionTurn.Terminal.parse({
            phase: "terminal",
            turnId,
            kind: "result",
            text: `message ${index}`,
            boundaryActionId: turnId,
            resumeCount: 0,
          }),
        },
      },
    ],
  };
}
