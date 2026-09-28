import { sessionTree } from "../../helpers/session-tree";
import { turnTestLayer, catalogLayer } from "../../helpers/service-layers";
import { prepareChatFixture } from "../../helpers/chat-services";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "../../helpers/session-services";
import { Effect, Queue } from "effect";
import { expect, test } from "bun:test";
import { SEEDED_POLICY_ROWS } from "@openomni/policy";
import { z } from "zod";
import type { PolicyRow } from "@openomni/protocol";
import { session, closeSessions } from "../../../src/session-handle";
import { defineTool, eraseTool, sessionTool, createTurnDispatcher } from "../../../src/tool-dispatcher";
import { createSessionChatRunner } from "../../../src/session-chat-runner";
import { assistantStep } from "../../helpers/dispatching-runner";
import { isolated, isolatedLedger } from "../../helpers/isolated";
import { collector } from "../../helpers/observation-collector";
import { commitReceivedMessage } from "../../helpers/ingress";

/** The alarm table is gone: an armed alarm is an `alarm.arm` chain action with no settling child. */
function armAlarm(id: string): void {
  const ledger = isolatedLedger();
  const appended = ledger.session.actions.append({
    id, parentId: null, sessionId: "stop", kind: "alarm.arm",
    intent: { encodingVersion: 1, value: { phase: "intent", op: "alarm.arm" } },
    effect: { encodingVersion: 1, value: { phase: "result" } },
    ts: Date.now(), irreversible: true,
  }, ledger.kernel.row("stop").revision);
  if (appended === undefined) throw new Error("alarm.arm append refused");
}

function scenario(mode: "repeat" | "stall" | "blocked" | "wait" | "progress" | "prior-alarm") {
  return isolated(Effect.scoped(Effect.gen(function* () {
    const runtime: SessionRuntime = {
      observations: { publish: () => undefined },
      authorizeConfigure: allowConfigure,
      ...isolatedRuntime(),
      ...(mode === "stall" ? { openIntent: () => Effect.succeed([{ actionId: "unanswered-message", kind: "message" as const }]) } : {}),
    };
    const rows: PolicyRow.Row[] = SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 }));
    if (mode === "blocked") rows.push({ name: "deny-loop", kind: "tool", phase: "pre", generation: 1, priority: 1000, match: { encodingVersion: 1, value: { op: "loop" } }, verdict: { encodingVersion: 1, value: { type: "deny", reason: "blocked" } } });
    for (const row of rows) isolatedLedger().catalog.policies.append(row);
    let calls = 0;
    let bodies = 0;
    // The tool's raw Promise is settled only after its exact durable side effect commits.
    const requests = yield* Queue.unbounded<{ resolve: (value: string) => void }>();
    const definitions = [eraseTool(defineTool({
      name: "loop", description: "loop", category: "mutation", input: z.object({}), output: z.string(), visibility: { model: ["resident"], cell: [] },
      execute: () => new Promise<string>((resolve) => { Queue.offerUnsafe(requests, { resolve }); }), render: (_input, output) => output,
    }))];
    yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
      const request = yield* Queue.take(requests);
      bodies += 1;
      if (mode === "wait") yield* Effect.sync(() => armAlarm("current-alarm"));
      if (mode === "progress") yield* commitReceivedMessage(isolatedLedger().kernel, { id: `progress-${bodies}`, sessionId: "stop", kind: "prompt", content: `state ${bodies}`, origin: { encodingVersion: 1, value: { source: "fixture" } }, createdAt: Date.now(), parentActionId: null });
      request.resolve("ok");
    })));
    const runner = createSessionChatRunner({ prepare: (input) => Effect.gen(function* () {
      const dispatcher = (yield* Effect.gen(function* () { const turnInput = input; const turnRuntime = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer(definitions)), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
      return prepareChatFixture({
        traceContext: { traceId: "trace", sessionId: input.sessionId, runId: input.resultId },
        config: {
          events: collector(), executor: dispatcher.executor, model: { provider: "test", id: "test" }, tools: [...dispatcher.specs],
          toolWave: (calls, signal) => dispatcher.executeWave(calls, { sessionId: input.sessionId, turnId: input.turnId, signal }),
          toolExecutor: (call) => dispatcher.execute(call, { sessionId: input.sessionId, turnId: input.turnId }),
          llm: {
            resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
            run: (_request, sink) => Effect.sync(() => {
              calls += 1;
              const text = mode === "stall" || mode === "blocked" ? `attempt ${calls}` : mode === "prior-alarm" ? "" : "same";
              sink.onMessage(assistantStep(text, input.sessionId, "", mode === "stall" || mode === "prior-alarm" ? undefined : { id: `tool-${calls}`, callID: `call-${calls}`, tool: "loop" }));
              return { type: "stop" as const };
            }),
          },
        },
      }); }) });
    const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "stop", role: "resident", runner, tools: definitions.map(sessionTool) }, fixture), fixture); });
    if (mode === "prior-alarm") armAlarm("old-alarm");
    const result = yield* handle.prompt("work");
    const outcome = { result, calls, bodies, snapshot: handle.get(), actions: sessionTree(isolatedLedger().kernel, handle.id) };
    yield* closeSessions(runtime);
    return outcome;
  })));
}

for (const [mode, reason, count] of [
  ["repeat", "exact_repeat", 3], ["stall", "toolless_stall", 3], ["blocked", "blocked_recurrence", 3], ["progress", "continuation", 8],
] as const) {
  test(`real session ${mode} uses machine ${reason} with ${count} admitted steps`, async () => {
    const outcome = await scenario(mode);
    expect(outcome.result).toMatchObject({ kind: "error", cause: { code: "agent_stop", reason } });
    expect(outcome.calls).toBe(count);
    expect(outcome.snapshot.turns[0]?.terminal?.kind).toBe("error");
    if (mode === "blocked") expect(outcome.bodies).toBe(0);
    if (mode === "progress") expect(outcome.actions.filter((action) => action.kind === "inbox.deliver")).toHaveLength(9);
  });
}
test("only a still-armed action created by this turn permits a waiting terminal", async () => {
  const current = await scenario("wait");
  expect(current.result).toMatchObject({ kind: "waiting", reason: "live_wait", alarmIds: ["current-alarm"] });
  expect(current.calls).toBe(1);
  expect(current.snapshot.turns[0]?.terminal?.kind).toBe("waiting");
  // W5.2: there is no lease release — the waiting session keeps its pinned owner; takeover is a higher-fence adoption.
  expect(current.snapshot.lease.owner).not.toBeNull();
  const prior = await scenario("prior-alarm");
  expect(prior.result?.kind).toBe("error");
  expect(prior.snapshot.turns[0]?.terminal?.kind).not.toBe("waiting");
});
