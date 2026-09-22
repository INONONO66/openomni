import { Effect, Fiber } from "effect";
import { isolated } from "../../helpers/isolated";
import { dispatchingRunner } from "../../helpers/effect-g2";
import { expect, test, spyOn } from "bun:test";
import { seedPolicy } from "../../helpers/seed-policy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Message, canonicalDigest, type PlainValue, type Inbox } from "@openomni/protocol";
import { z } from "zod";
import { session, closeSessions, type SessionRuntime } from "../../../src/session-handle";
import { createSessionChatRunner } from "../../../src/session-chat-runner";
import {
  createTurnDispatcher,
  sessionTool,
  defineTool,
  eraseTool,
} from "../../../src/tool-dispatcher";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { restoreCompactionProjection } from "../../../src/compaction/durable";
import { assistantStep } from "../../helpers/dispatching-runner";

const object = (value: PlainValue) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

test("reopened SQLite hydrates exact tool-bearing assistant identities and rendered results", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "937-history-"));
        const dbPath = join(directory, "chat.sqlite");
        const definitions = [
          eraseTool(
            defineTool({
              name: "read",
              description: "read",
              category: "query",
              visibility: { model: ["resident"], cell: [] },
              input: z.object({}),
              output: z.number(),
              execute: async () => 42,
              render: (_input: Record<string, never>, value: number) => `verbatim:${value}`,
            }),
          ),
        ];
        let calls = 0;
        const inputs: Message.WithParts[][] = [];
        let runtime: SessionRuntime = { observations: { publish: () => undefined } };
        const runner = dispatchingRunner(
          definitions,
          () => runtime,
          async (
            request: import("@openomni/llm").RunInput,
            sink: import("@openomni/llm").Sink,
            input: import("../../../src/session-handle").SessionRunnerInput,
          ) => {
            inputs.push(structuredClone(request.messages));
            calls += 1;
            sink.onMessage(
              assistantStep(
                calls === 1 ? "working" : "finished",
                input.sessionId,
                request.messages.at(-1)?.info.id ?? "",
                calls === 1 ? { id: "tool-part", callID: "read-call", tool: "read" } : undefined,
              ),
            );
            return { type: "stop" };
          },
        );
        try {
          Storage.reset();
          Storage.initialize({ dbPath });
          seedPolicy();
          const options = {
            id: "history",
            role: "resident" as const,
            runner,
            tools: definitions.map(sessionTool),
          };
          const first = yield* session(options, runtime);
          expect((yield* first.prompt("first"))?.kind).toBe("result");
          const preserved = inputs[1]?.find(
            (message: import("@openomni/protocol").Message.WithParts) =>
              message.parts.some(
                (part: import("@openomni/protocol").Message.WithParts["parts"][number]) =>
                  part.type === "tool",
              ),
          );
          expect(preserved?.parts).toContainEqual(
            expect.objectContaining({
              type: "tool",
              callID: "read-call",
              state: expect.objectContaining({ status: "completed", output: "verbatim:42" }),
            }),
          );
          yield* closeSessions(runtime);
          Storage.reset();
          Storage.initialize({ dbPath });
          runtime = { observations: { publish: () => undefined } };
          expect((yield* (yield* session(options, runtime)).prompt("after reopen"))?.kind).toBe(
            "result",
          );
          const restored = inputs[2]?.find(
            (message: import("@openomni/protocol").Message.WithParts) =>
              message.info.id === preserved?.info.id,
          );
          expect(restored).toEqual(preserved);
          expect(
            inputs[2]?.filter(
              (message: import("@openomni/protocol").Message.WithParts) =>
                message.info.id === preserved?.info.id,
            ),
          ).toHaveLength(1);
          expect(
            SessionHandleStore.tree("history").filter(
              (action: import("@openomni/protocol").LedgerAction.Node) => action.kind === "message",
            ),
          ).not.toHaveLength(0);
        } finally {
          yield* closeSessions(runtime);
          Storage.reset();
          rmSync(directory, { recursive: true, force: true });
        }
      }),
    ),
  ));

test("compaction projection and lossless revert survive SQLite reopen without deleting originals", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "937-compaction-reopen-"));
        const dbPath = join(directory, "chat.sqlite");
        let runtime: SessionRuntime = { observations: { publish: () => undefined } };
        let calls = 0;
        let reopenedInput: Message.WithParts[] = [];
        let nextBoundary: Message.WithParts[] = [];
        let afterConcurrent: Message.WithParts[] = [];
        const summarizing = Promise.withResolvers<void>();
        const summary = Promise.withResolvers<string>();
        const runner = createSessionChatRunner({
          prepare(input: import("../../../src/session-handle").SessionRunnerInput) {
            const dispatcher = createTurnDispatcher([], input, runtime);
            return {
              traceContext: { traceId: "trace", sessionId: input.sessionId, runId: input.resultId },
              config: {
                events: { publish: () => undefined },
                executor: dispatcher.executor,
                model: { provider: "test", id: "test" },
                compaction: {
                  contextWindowTokens: 10000,
                  protectRecentMessages: 1,
                  speculate: false,
                  onSummarize: () =>
                    Effect.gen(function* () {
                      summarizing.resolve();
                      return yield* Effect.promise(() => summary.promise);
                    }),
                },
                llm: {
                  resolveModel: () =>
                    Effect.succeed({
                      providerID: "test",
                      id: "test",
                      name: "test",
                      limit: { context: 10000 },
                    }),
                  run: (
                    request: import("@openomni/llm").RunInput,
                    sink: import("@openomni/llm").Sink,
                  ) =>
                    Effect.sync(() => {
                      calls += 1;
                      if (calls === 3) nextBoundary = structuredClone(request.messages);
                      if (calls === 4) reopenedInput = structuredClone(request.messages);
                      const message = createAssistantMessage(
                        calls < 3 ? "evidence ".repeat(1000) : "finished",
                        "",
                        input.sessionId,
                      );
                      if (message.info.role !== "assistant") throw new Error("assistant required");
                      message.info.tokens.input = calls < 3 ? 6000 : 1;
                      message.parts.push({
                        id: `${message.info.id}:finish`,
                        sessionID: input.sessionId,
                        messageID: message.info.id,
                        type: "step-finish",
                        reason: "stop",
                        cost: 0,
                        tokens: message.info.tokens,
                      });
                      if (calls === 3)
                        afterConcurrent = structuredClone([...request.messages, message]);
                      sink.onMessage(message);
                      return { type: "stop" };
                    }),
                },
              },
            };
          },
        });
        try {
          Storage.reset();
          Storage.initialize({ dbPath });
          seedPolicy();
          const options = { id: "compact", role: "resident" as const, runner };
          const handle = yield* session(options, runtime);
          yield* handle.prompt("first");
          const second = yield* Effect.forkScoped(handle.prompt("second"));
          yield* Effect.promise(() => summarizing.promise).pipe(Effect.timeout("5 seconds"));
          const admitted = Promise.withResolvers<void>();
          const commitInbox = SessionHandleStore.commitInbox;
          let count = 0;
          const tap = spyOn(SessionHandleStore, "commitInbox").mockImplementation(
            (inbox: Inbox.Commit) =>
              commitInbox(inbox).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (inbox.content.startsWith("during-") && ++count === 2) admitted.resolve();
                  }),
                ),
              ),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => tap.mockRestore()));
          const concurrent = yield* Effect.forEach(["during-1", "during-2"], (content: string) =>
            Effect.forkScoped(handle.prompt(content)),
          );
          yield* Effect.promise(() => admitted.promise).pipe(Effect.timeout("5 seconds"));
          const pending = SessionHandleStore.pendingInbox("compact");
          expect(
            pending.map((item: import("@openomni/protocol").Inbox.Row) => item.content),
          ).toEqual(["during-1", "during-2"]);
          summary.resolve("checkpoint");
          yield* Effect.forEach([second, ...concurrent], Fiber.join);
          const before = SessionHandleStore.tree("compact");
          const node = [...before]
            .reverse()
            .find(
              (action: import("@openomni/protocol").LedgerAction.Node) =>
                action.kind === "compaction" &&
                object(action.effect.value)?.terminal === "executed",
            );
          const payload = object(object(node?.effect.value ?? null)?.result ?? null);
          if (payload === undefined || !Array.isArray(payload.projection))
            throw new Error("missing compaction projection");
          const projection = payload.projection.map(
            (entry: import("@openomni/protocol").PlainValue) => Message.WithParts.parse(entry),
          );
          expect(nextBoundary.slice(0, -2)).toEqual(projection);
          expect(
            nextBoundary
              .slice(-2)
              .map((message: import("@openomni/protocol").Message.WithParts) => message.info.id),
          ).toEqual(pending.map((item: import("@openomni/protocol").Inbox.Row) => item.id));
          const record = z
            .object({
              summary: z.string(),
              firstKeptEntryId: z.string(),
              tokensBefore: z.number(),
              discarded: z.object({
                firstEntryId: z.string(),
                lastEntryId: z.string(),
                count: z.number(),
                sha256: z.string(),
              }),
              revert: z.object({
                removedEntries: z.array(Message.WithParts),
                priorAnchorEntryId: z.string().nullable(),
              }),
            })
            .parse(payload);
          const restored = restoreCompactionProjection(projection, record);
          expect(canonicalDigest(record.revert.removedEntries)).toBe(record.discarded.sha256);
          expect(restored.slice(0, record.discarded.count)).toEqual(record.revert.removedEntries);
          yield* closeSessions(runtime);
          Storage.reset();
          Storage.initialize({ dbPath });
          runtime = { observations: { publish: () => undefined } };
          yield* (yield* session(options, runtime)).prompt("reopened");
          expect(reopenedInput.slice(0, -1)).toEqual(afterConcurrent);
          expect(SessionHandleStore.tree("compact").slice(0, before.length)).toEqual(before);
        } finally {
          yield* closeSessions(runtime);
          Storage.reset();
          rmSync(directory, { recursive: true, force: true });
        }
      }),
    ),
  ));
