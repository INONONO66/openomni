import { runFixtureSync } from "./effect-result";
import { executionReads } from "./execution-reads";
import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import type { SessionFixture as SessionRuntime } from "./session-services";
import { Effect, Either } from "effect";
import { SessionHandleStore, type LedgerError } from "@openomni/ledger";
import type { ExecutionLedger } from "../../src/executor";
import { commitSessionRequest } from "../../src/session-admission";
import { commitFoldBatch } from "../../src/session-fold-commit";
import type { LedgerAction, LedgerSession, SessionTransition } from "@openomni/protocol";
import { collector } from "./observation-collector";
export { bounded } from "./bounded";

export function requestLedger(
  input: {
    id?: string;
    turnId?: string;
    resultId?: string;
    legacy?: boolean;
    clock?: () => number;
    onRequest?: (request: SessionTransition.Request) => void;
    domainRevisions?: SessionRuntime["requestDomainRevisions"];
  } = {},
) {
  const id = input.id ?? "request-session";
  const clock = input.clock ?? (() => 100);
  const created = Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        SessionHandleStore.materialize({
          id,
          role: "resident",
          parentId: null,
          policyGeneration: 1,
          tools: [],
          system: { preset: "", blocks: [] },
          actionId: `${id}:configure`,
          at: clock(),
        }),
      ),
    ),
    (error: LedgerError) => error,
  );
  const owner = `${id}:owner`;
  const lease = Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        SessionHandleStore.acquireLease({
          sessionId: id,
          owner,
          expectedFence: created.row.leaseFence,
          now: clock(),
          expiresAt: clock() + 30_000,
        }),
      ),
    ),
    (error: LedgerError) => error,
  );
  if (!lease.ok) throw new Error("test lease refused");
  const generation = SessionHandleStore.latestGeneration(sessionTree(id));
  const turnId = input.turnId ?? `${id}:turn`;
  const commit = input.legacy === true ? SessionHandleStore.commit : commitFoldBatch;
  if (!sessionTree(id).some((action: LedgerAction.Node) => action.id === turnId)) {
    const row = SessionHandleStore.row(id);
    const opened = Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          commit({
            sessionId: id,
            owner,
            fence: lease.fence,
            now: clock(),
            expectedRevision: row.revision,
            consumeInboxIds: [],
            state: "running",
            releaseLease: false,
            actions: [
              {
                id: turnId,
                sessionId: id,
                parentId: `${id}:configure`,
                kind: "turn",
                intent: {
                  encodingVersion: 1,
                  value: {
                    phase: "intent",
                    resultId: input.resultId ?? `${id}:result`,
                    inboxIds: [],
                    resumeCount: 0,
                    boundaryActionId: null,
                    toolsGeneration: generation.generation,
                    toolsHash: generation.toolsHash,
                    systemHash: generation.systemHash,
                    policyGeneration: 1,
                  },
                },
                effect: { encodingVersion: 1, value: { phase: "pending" } },
                ts: clock(),
                irreversible: true,
              },
            ],
          }),
        ),
      ),
      (error: LedgerError) => error,
    );
    if (!opened.ok) throw new Error("test turn refused");
  }
  const runtime: SessionRuntime = {
    clock,
    observations: collector(),
    requestDomainRevisions: input.domainRevisions,
  };
  const ledger: ExecutionLedger = {
    ...executionReads(id),
    commit(action: LedgerAction.Append) {
      return Effect.gen(function* () {
        const row = SessionHandleStore.row(id);
        const committed = yield* commitFoldBatch({
          sessionId: id,
          owner,
          fence: lease.fence,
          now: clock(),
          expectedRevision: row.revision,
          actions: [action],
          consumeInboxIds: [],
          state: row.state,
          releaseLease: false,
        });
        const receipt = committed.receipts[0];
        if (receipt === undefined) throw new Error("test receipt missing");
        return receipt;
      });
    },
    transition(payload: SessionTransition.Payload, inputId: string, at: number) {
      return Effect.gen(function* () {
        const decision = yield* commitSessionRequest(
          id,
          { owner, fence: lease.fence },
          payload,
          inputId,
          at,
          runtime,
        );
        if (decision.request !== undefined) input.onRequest?.(decision.request);
        return decision;
      });
    },
  };
  return {
    commitBatch(actions: readonly LedgerAction.Append[], overrides: Partial<LedgerSession.Commit> = {}) {
      const row = SessionHandleStore.row(id);
      return runFixtureSync(commitFoldBatch({
        sessionId: id, owner, fence: lease.fence, now: clock(), expectedRevision: row.revision,
        actions: [...actions], consumeInboxIds: [], state: row.state, releaseLease: false,
        ...overrides,
      }));
    },
    ledger,
    identity: {
      sessionId: id,
      role: "resident" as const,
      parentActionId: turnId,
      turnId,
      toolsGeneration: generation.generation,
      toolsHash: generation.toolsHash,
      systemHash: generation.systemHash,
    },
    entropy: () => crypto.randomUUID(),
    clock,
  };
}
