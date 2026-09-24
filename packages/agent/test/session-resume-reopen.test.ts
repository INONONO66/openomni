import { PlainValueSchema } from "@openomni/protocol";
import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { turnTestLayer, catalogLayer } from "./helpers/service-layers";
import { prepareChatFixture } from "./helpers/chat-services";
import { allowConfigure, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import type { RunInput, Sink } from "@openomni/llm";
import type { LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import { isolated } from "./helpers/isolated";
import { awaitSignal, boundedSignal, failure } from "./helpers/g0-signals";
import { expect, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import { SessionTurn } from "@openomni/protocol";
import { session, closeSessions, sweepSessions, type SessionRunnerInput } from "../src/session-handle";
import { createSessionChatRunner } from "../src/session-chat-runner";
import { createTurnDispatcher } from "../src/tool-dispatcher";
import { createAssistantMessage } from "../src/core/message-factory";

for (const mode of ["interrupted", "crash-open"] as const) {
  test(`reopened SQLite ${mode} chooses the correct IDs and generation with no stale-fence writes`, () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = mkdtempSync(join(tmpdir(), "937-resume-"));
          const dbPath = join(directory, "chat.sqlite");
          let runtime: SessionRuntime = {
            authorizeConfigure: allowConfigure,
            observations: { publish: () => undefined },
            clock: () => 1000,
          };
          const entered = Promise.withResolvers<void>();
          const inputs: SessionRunnerInput[] = [];
          let opening = mode === "interrupted";
          const runner = createSessionChatRunner({
            prepare: (input: SessionRunnerInput) => Effect.gen(function* () {
              inputs.push(input);
              return prepareChatFixture({
                traceContext: {
                  traceId: "trace",
                  sessionId: input.sessionId,
                  runId: input.resultId,
                },
                config: {
                  events: { publish: () => undefined },
                  executor: (yield* Effect.gen(function* () { const turnInput = input; const turnRuntime = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); })).executor,
                  model: { provider: "test", id: "test" },
                  llm: {
                    resolveModel: () =>
                      Effect.sync(() => {
                        return { id: "test", name: "test", providerID: "test" };
                      }),
                    run: (_request: RunInput, sink: Sink) =>
                      Effect.gen(function* () {
                        if (opening) {
                          opening = false;
                          entered.resolve();
                          return yield* Effect.never;
                        }
                        sink.onMessage(createAssistantMessage("recovered", "", input.sessionId));
                        return { type: "stop" };
                      }),
                  },
                },
              }); }),
          });
          try {
            Storage.reset();
            Storage.initialize({ dbPath });
            seedPolicy();
            let originalTurn = "crashed-turn";
            let originalResult = "crashed-result";
            if (mode === "interrupted") {
              const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "resume", role: "resident", runner }, fixture), fixture); });
              const first = yield* Effect.fork(handle.prompt("original"));
              yield* boundedSignal(entered.promise, "provider entered");
              yield* awaitSignal(handle.interrupt());
              expect((yield* awaitSignal(first))?.kind).toBe("interrupted");
              const captured = inputs[0];
              if (captured === undefined) throw new Error("missing first invocation");
              originalTurn = captured.turnId;
              originalResult = captured.resultId;
              yield* awaitSignal(
                handle.system.blocks.set([
                  { id: "new", source: "fixture", content: "generation two" },
                ]),
              );
              yield* SessionHandleStore.commitInbox({
                id: "resume-request",
                sessionId: "resume",
                kind: "resume",
                content: "",
                createdAt: 1001,
                origin: { encodingVersion: 1, value: { source: "fixture" } },
                parentActionId: originalResult,
              });
            } else {
              yield* SessionHandleStore.materialize({
                id: "resume",
                role: "resident",
                parentId: null,
                tools: [],
                system: { preset: "", blocks: [] },
                policyGeneration: 1,
                actionId: "initial",
                at: 1,
              });
              const generation = SessionHandleStore.latestGeneration(
                sessionTree("resume"),
              );
              const lease = yield* SessionHandleStore.acquireLease({
                sessionId: "resume",
                owner: "crashed",
                expectedFence: 0,
                now: 1,
                expiresAt: 10,
              });
              if (!lease.ok) throw new Error("missing fixture lease");
              const newer = SessionHandleStore.generationSnapshot({
                generation: 2,
                revertTo: 1,
                tools: [],
                system: {
                  preset: "",
                  blocks: [{ id: "new", source: "fixture", content: "generation two" }],
                },
                policyGeneration: 1,
              });
              const commit = yield* SessionHandleStore.commit({
                sessionId: "resume",
                owner: "crashed",
                fence: lease.fence,
                now: 2,
                expectedRevision: SessionHandleStore.row("resume").revision,
                consumeInboxIds: [],
                releaseLease: false,
                state: "running",
                generation: {
                  toolsGeneration: 2,
                  systemHash: newer.systemHash,
                  policyGeneration: 1,
                },
                actions: [
                  {
                    id: originalTurn,
                    sessionId: "resume",
                    parentId: "initial",
                    kind: "turn",
                    intent: {
                      encodingVersion: 1,
                      value: PlainValueSchema.parse(SessionTurn.DecodeIntent.parse({
                        phase: "intent",
                        resultId: originalResult,
                        inboxIds: [],
                        resumeCount: 0,
                        boundaryActionId: "initial",
                        toolsGeneration: 1,
                        toolsHash: generation.toolsHash,
                        systemHash: generation.systemHash,
                        policyGeneration: 1,
                      })),
                    },
                    effect: { encodingVersion: 1, value: { phase: "pending" } },
                    irreversible: true,
                    ts: 2,
                  },
                  SessionHandleStore.configureAction({
                    id: "newer",
                    sessionId: "resume",
                    parentId: originalTurn,
                    operation: "system.blocks.set",
                    snapshot: newer,
                    at: 3,
                  }),
                ],
              });
              expect(commit.ok).toBe(true);
            }
            const immutable = sessionTree("resume");
            yield* awaitSignal(closeSessions(runtime));
            Storage.reset();
            Storage.initialize({ dbPath });
            runtime = { observations: { publish: () => undefined }, clock: () => 2000, authorizeConfigure: allowConfigure };
            yield* awaitSignal(Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(sweepSessions(() => runner, fixture), fixture); }));
            const recovered = inputs.at(-1);
            if (recovered === undefined) throw new Error("missing recovered invocation");
            expect(recovered.toolsGeneration).toBe(mode === "crash-open" ? 1 : 2);
            if (mode === "crash-open") {
              expect(recovered.turnId).toBe(originalTurn);
              expect(recovered.resultId).toBe(originalResult);
            } else {
              expect(recovered.turnId).not.toBe(originalTurn);
              expect(recovered.resultId).not.toBe(originalResult);
            }
            const tree = sessionTree("resume");
            expect(tree.slice(0, immutable.length)).toEqual(immutable);
            expect(
              tree.filter(
                (action: LedgerAction.Node) =>
                  SessionHandleStore.turnTerminal(action)?.turnId === recovered.turnId,
              ),
            ).toHaveLength(1);
            const stale = SessionHandleStore.commit({
              sessionId: "resume",
              owner: "crashed",
              fence: 1,
              now: 2000,
              expectedRevision: SessionHandleStore.row("resume").revision,
              actions: [],
              consumeInboxIds: [],
              state: "running",
              releaseLease: false,
            });
            expect(yield* failure(stale)).toMatchObject({ _tag: "CommitRefused", reason: "fence" });
            expect(sessionTree("resume")).toEqual(tree);
          } finally {
            yield* awaitSignal(closeSessions(runtime));
            Storage.reset();
            rmSync(directory, { recursive: true, force: true });
          }
        }),
      ),
    ));
}
