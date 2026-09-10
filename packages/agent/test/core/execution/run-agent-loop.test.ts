import { expect, test } from "bun:test";
import { seedPolicy } from "../../helpers/seed-policy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Message, canonicalDigest, type PlainValue } from "@openomni/protocol";
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
import { bounded } from "../../helpers/bounded";
import { assistantStep, dispatchingRunner } from "../../helpers/dispatching-runner";

const object = (value: PlainValue) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

test("reopened SQLite hydrates exact tool-bearing assistant identities and rendered results", () =>
  Storage.withIsolation(async () => {
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
          render: (_input, value) => `verbatim:${value}`,
        }),
      ),
    ];
    let calls = 0;
    const inputs: Message.WithParts[][] = [];
    let runtime: SessionRuntime = { observations: { publish: () => undefined } };
    const runner = dispatchingRunner(
      definitions,
      () => runtime,
      async (request, sink, input) => {
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
      Storage.initialize({ dbPath });
      seedPolicy();
      const options = {
        id: "history",
        role: "resident" as const,
        runner,
        tools: definitions.map(sessionTool),
      };
      const first = session(options, runtime);
      expect((await first.prompt("first"))?.kind).toBe("result");
      const preserved = inputs[1]?.find((message) =>
        message.parts.some((part) => part.type === "tool"),
      );
      expect(preserved?.parts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          callID: "read-call",
          state: expect.objectContaining({ status: "completed", output: "verbatim:42" }),
        }),
      );
      await closeSessions(runtime);
      Storage.reset();
      Storage.initialize({ dbPath });
      runtime = { observations: { publish: () => undefined } };
      expect((await session(options, runtime).prompt("after reopen"))?.kind).toBe("result");
      const restored = inputs[2]?.find((message) => message.info.id === preserved?.info.id);
      expect(restored).toEqual(preserved);
      expect(inputs[2]?.filter((message) => message.info.id === preserved?.info.id)).toHaveLength(
        1,
      );
      expect(
        SessionHandleStore.tree("history").filter((action) => action.kind === "message"),
      ).not.toHaveLength(0);
    } finally {
      await closeSessions(runtime);
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }));

test("compaction projection and lossless revert survive SQLite reopen without deleting originals", () =>
  Storage.withIsolation(async () => {
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
      prepare(input) {
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
              onSummarize: async () => {
                summarizing.resolve();
                return summary.promise;
              },
            },
            llm: {
              resolveModel: async () => ({
                providerID: "test",
                id: "test",
                name: "test",
                limit: { context: 10000 },
              }),
              run: async (request, sink) => {
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
                if (calls === 3) afterConcurrent = structuredClone([...request.messages, message]);
                sink.onMessage(message);
                return { type: "stop" };
              },
            },
          },
        };
      },
    });
    try {
      Storage.initialize({ dbPath });
      seedPolicy();
      const options = { id: "compact", role: "resident" as const, runner };
      const handle = session(options, runtime);
      await handle.prompt("first");
      const second = handle.prompt("second");
      await bounded(summarizing.promise);
      const concurrent = [handle.prompt("during-1"), handle.prompt("during-2")];
      const pending = SessionHandleStore.pendingInbox("compact");
      expect(pending.map((item) => item.content)).toEqual(["during-1", "during-2"]);
      summary.resolve("checkpoint");
      await bounded(Promise.all([second, ...concurrent]));
      const before = SessionHandleStore.tree("compact");
      const node = [...before]
        .reverse()
        .find(
          (action) =>
            action.kind === "compaction" && object(action.effect.value)?.terminal === "executed",
        );
      const payload = object(object(node?.effect.value ?? null)?.result ?? null);
      if (payload === undefined || !Array.isArray(payload.projection))
        throw new Error("missing compaction projection");
      const projection = payload.projection.map((entry) => Message.WithParts.parse(entry));
      expect(nextBoundary.slice(0, -2)).toEqual(projection);
      expect(nextBoundary.slice(-2).map((message) => message.info.id)).toEqual(
        pending.map((item) => item.id),
      );
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
      await closeSessions(runtime);
      Storage.reset();
      Storage.initialize({ dbPath });
      runtime = { observations: { publish: () => undefined } };
      await session(options, runtime).prompt("reopened");
      expect(reopenedInput.slice(0, -1)).toEqual(afterConcurrent);
      expect(SessionHandleStore.tree("compact").slice(0, before.length)).toEqual(before);
    } finally {
      await closeSessions(runtime);
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
