import { expect, test } from "bun:test";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import { SEEDED_POLICY_ROWS } from "@openomni/policy";
import { z } from "zod";
import type { Message, PolicyRow } from "@openomni/protocol";
import { session, closeSessions, type SessionRuntime } from "../../../src/session-handle";
import { createSessionChatRunner } from "../../../src/session-chat-runner";
import {
  createTurnDispatcher,
  defineTool,
  eraseTool,
  sessionTool,
} from "../../../src/tool-dispatcher";
import { createAssistantMessage } from "../../../src/core/message-factory";

async function scenario(
  mode: "repeat" | "stall" | "blocked" | "wait" | "progress" | "prior-alarm",
) {
  return Storage.withIsolation(async () => {
    Storage.initialize({ dbPath: ":memory:" });
    const runtime: SessionRuntime = {
      observations: { publish: () => undefined },
      ...(mode === "stall"
        ? { openIntent: async () => [{ actionId: "unanswered-message", kind: "message" as const }] }
        : {}),
    };
    const rows: PolicyRow.Row[] = SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 }));
    if (mode === "blocked")
      rows.push({
        name: "deny-loop",
        kind: "tool",
        phase: "pre",
        generation: 1,
        priority: 1000,
        match: { encodingVersion: 1, value: { op: "loop" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "blocked" } },
      });
    for (const row of rows) Storage.get().policies?.append(row);
    let calls = 0;
    let bodies = 0;
    const definitions = [
      eraseTool(
        defineTool({
          name: "loop",
          description: "loop",
          category: "mutation",
          input: z.object({}),
          output: z.string(),
          visibility: { model: ["resident"], cell: [] },
          async execute(_input, context) {
            bodies += 1;
            if (mode === "wait")
              Storage.get().alarms?.arm({
                id: "current-alarm",
                sessionId: context.sessionId,
                kind: "at",
                fireAt: Date.now() + 60000,
              });
            if (mode === "progress")
              SessionHandleStore.commitInbox({
                id: `progress-${bodies}`,
                sessionId: context.sessionId,
                kind: "prompt",
                content: `state ${bodies}`,
                origin: { encodingVersion: 1, value: { source: "fixture" } },
                createdAt: Date.now(),
                parentActionId: null,
              });
            return "ok";
          },
          render: (_input, output) => output,
        }),
      ),
    ];
    const runner = createSessionChatRunner({
      prepare(input) {
        const dispatcher = createTurnDispatcher(definitions, input, runtime);
        return {
          traceContext: { traceId: "trace", sessionId: input.sessionId, runId: input.resultId },
          config: {
            events: { publish: () => undefined },
            executor: dispatcher.executor,
            model: { provider: "test", id: "test" },
            tools: [...dispatcher.specs],
            toolWave: (calls, signal) =>
              dispatcher.executeWave(calls, {
                sessionId: input.sessionId,
                turnId: input.turnId,
                signal,
              }),
            toolExecutor: (call) =>
              dispatcher.execute(call, { sessionId: input.sessionId, turnId: input.turnId }),
            llm: {
              resolveModel: async () => ({ providerID: "test", id: "test", name: "test" }),
              run: async (_request, sink) => {
                calls += 1;
                const message: Message.WithParts = createAssistantMessage(
                  mode === "stall" || mode === "blocked"
                    ? `attempt ${calls}`
                    : mode === "prior-alarm"
                      ? ""
                      : "same",
                  "",
                  input.sessionId,
                );
                if (mode !== "stall" && mode !== "prior-alarm")
                  message.parts.push({
                    id: `tool-${calls}`,
                    messageID: message.info.id,
                    sessionID: input.sessionId,
                    type: "tool",
                    callID: `call-${calls}`,
                    tool: "loop",
                    state: { status: "pending", input: {} },
                  });
                sink.onMessage(message);
                return { type: "stop" };
              },
            },
          },
        };
      },
    });
    const handle = session(
      { id: "stop", role: "resident", runner, tools: definitions.map(sessionTool) },
      runtime,
    );
    if (mode === "prior-alarm")
      Storage.get().alarms?.arm({
        id: "old-alarm",
        sessionId: handle.id,
        kind: "at",
        fireAt: Date.now() + 60000,
      });
    try {
      const result = await handle.prompt("work");
      return {
        result,
        calls,
        bodies,
        snapshot: handle.get(),
        actions: SessionHandleStore.tree(handle.id),
      };
    } finally {
      await closeSessions(runtime);
      Storage.reset();
    }
  });
}

for (const [mode, reason, count] of [
  ["repeat", "exact_repeat", 3],
  ["stall", "toolless_stall", 3],
  ["blocked", "blocked_recurrence", 3],
  ["progress", "continuation", 8],
] as const) {
  test(`real session ${mode} uses machine ${reason} with ${count} admitted steps`, async () => {
    const outcome = await scenario(mode);
    expect(outcome.result).toMatchObject({ kind: "error", cause: { code: "agent_stop", reason } });
    expect(outcome.calls).toBe(count);
    expect(outcome.snapshot.turns[0]?.terminal?.kind).toBe("error");
    if (mode === "blocked") expect(outcome.bodies).toBe(0);
    if (mode === "progress")
      expect(outcome.actions.filter((action) => action.kind === "inbox.deliver")).toHaveLength(9);
  });
}

test("only a still-armed action created by this turn permits a waiting terminal", async () => {
  const current = await scenario("wait");
  expect(current.result).toMatchObject({
    kind: "waiting",
    reason: "live_wait",
    alarmIds: ["current-alarm"],
  });
  expect(current.calls).toBe(1);
  expect(current.snapshot.turns[0]?.terminal?.kind).toBe("waiting");
  expect(current.snapshot.lease.owner).toBeNull();
  const prior = await scenario("prior-alarm");
  expect(prior.result?.kind).toBe("error");
  expect(prior.snapshot.turns[0]?.terminal?.kind).not.toBe("waiting");
});
