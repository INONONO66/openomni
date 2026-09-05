import { SessionTurn } from "@openomni/protocol";
import { SessionHandleStore } from "../src/index";
import { materializeSession } from "../test/helpers/session";

/** Populate canonical turn history through the same fenced L0 commit as handles. */
export function sessionHistory(id: string): void {
  materializeSession(id);
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(id));
  for (let index = 0; index < 10; index += 1) {
    const row = SessionHandleStore.row(id);
    const turnId = `${id}:turn:${index}`;
    const resultId = `${turnId}:result`;
    const now = index + 2;
    const lease = SessionHandleStore.acquireLease({
      sessionId: id,
      owner: "bench",
      expectedFence: row.leaseFence,
      now,
      expiresAt: now + 100,
    });
    if (!lease.ok) throw new Error("benchmark lease refused");
    const committed = SessionHandleStore.commit({
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
          parentId: SessionHandleStore.tree(id).at(-1)?.id ?? null,
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
    });
    if (!committed.ok) throw new Error("benchmark turn commit refused");
  }
}
