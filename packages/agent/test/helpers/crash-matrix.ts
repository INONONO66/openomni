import { SessionHandleStore, Storage } from "@openomni/ledger";
import { PlainObjectSchema, PlainValueSchema, type LedgerAction } from "@openomni/protocol";
import { z } from "zod";
import { createExecutor, type ExecutionLedger } from "../../src/executor";
import { executeCompaction } from "../../src/compaction/execute-cut";
import { session, type SessionRuntime } from "../../src/session-handle";
import { createTurnDispatcher } from "../../src/tool-dispatcher";
import { requestLedger } from "./request-ledger";
import { compiledPolicy } from "./compiled-policy";
import { runChatAttempts } from "./chat-attempts";
import { providerFailure } from "./mock-llm";
import { stringQueryTool } from "./query-tool";
import { textMessage } from "./messages";
import { seedPolicy } from "./seed-policy";

export const crashPoint = z.enum([
  "turn_intent_before_llm_entry",
  "llm_body_before_attempt_result_commit",
  "llm_result_committed",
  "tool_wave_between_result_commits",
  "retry_backoff_wait",
  "compaction_summary_before_result_commit",
  "inbox_admitted_before_turn_open",
  "outbound_reply_before_delivery_settle",
]);
export const recovery = z.enum([
  "resumed_without_reexecution",
  "replayed",
  "rearmed",
  "not_durable",
  "lost",
]);
export const matrixSchema = z
  .object({
    version: z.literal(1),
    rows: z.array(z.object({ crashPoint, recovery, note: z.string().min(1) }).strict()).min(7),
  })
  .strict();
export const crashWitness = z
  .object({
    crashPoint,
    bodies: z.array(z.string()),
    pending: z.object({ kind: z.string(), effect: PlainObjectSchema }).optional(),
  })
  .strict();
export type CrashPoint = z.infer<typeof crashPoint>;
export const sessionId = "crash-session";
export const observations = { publish: () => undefined };
export const effectOf = (action: LedgerAction.Append) =>
  PlainObjectSchema.parse(action.effect.value);
export const intentOf = (action: LedgerAction.Append) =>
  PlainObjectSchema.parse(action.intent.value);

// The worker exits without unwinding the executor or returning from the intercepted port.
function stop(point: CrashPoint, bodies: string[], pending?: LedgerAction.Append): Promise<never> {
  const witness = crashWitness.parse({
    crashPoint: point,
    bodies,
    ...(pending === undefined
      ? {}
      : { pending: { kind: pending.kind, effect: pending.effect.value } }),
  });
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(witness)}\n`, () => process.exit(0));
  });
}

function intercept(ledger: ExecutionLedger, point: CrashPoint, bodies: string[]): ExecutionLedger {
  let toolResults = 0;
  return {
    ...ledger,
    async commit(action) {
      const result = effectOf(action).phase === "result";
      if (action.kind === "tool" && result) toolResults += 1;
      const before =
        (point === "llm_body_before_attempt_result_commit" &&
          action.kind === "attempt" &&
          result) ||
        (point === "tool_wave_between_result_commits" &&
          action.kind === "tool" &&
          toolResults === 2 &&
          result) ||
        (point === "compaction_summary_before_result_commit" &&
          action.kind === "compaction" &&
          result);
      if (before) return stop(point, bodies, action);
      const receipt = await ledger.commit(action);
      if (point === "llm_result_committed" && action.kind === "llm" && result)
        return stop(point, bodies, action);
      return receipt;
    },
  };
}

async function executePoint(point: CrashPoint, bodies: string[]) {
  const recording = requestLedger({ id: sessionId });
  if (point === "turn_intent_before_llm_entry") return stop(point, bodies);
  const ledger = intercept(recording.ledger, point, bodies);
  const executor = createExecutor({
    ...recording,
    ledger,
    policy: compiledPolicy(),
    observations,
    waitRetry: () => stop(point, bodies),
  });
  if (point === "tool_wave_between_result_commits") {
    const tools = ["first", "second"].map((name) =>
      stringQueryTool(name, name, async () => {
        bodies.push(name);
        return name;
      }),
    );
    const dispatcher = createTurnDispatcher(
      tools,
      {
        ...recording.identity,
        actionId: recording.identity.turnId,
        ledger,
        policy: compiledPolicy(),
      },
      { observations, clock: recording.clock, entropy: recording.entropy },
    );
    return dispatcher.executeWave(
      tools.map((tool) => ({ id: tool.name, tool: tool.name, input: {} })),
      {
        sessionId,
        turnId: recording.identity.turnId,
      },
    );
  }
  if (point === "compaction_summary_before_result_commit") {
    const history = [
      textMessage("assistant", "earlier evidence ".repeat(200), sessionId, "earlier"),
      textMessage("assistant", "answer", sessionId, "answer"),
    ];
    for (const message of history) {
      await executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, async () =>
        PlainValueSchema.parse(message),
      );
    }
    return executeCompaction({
      history,
      executor,
      events: observations,
      options: {
        contextWindowTokens: 10_000,
        protectRecentMessages: 1,
        onSummarize: async () => {
          bodies.push("summary");
          return "checkpoint";
        },
      },
      identity: { traceId: "crash", sessionId },
      dispatch: { trigger: "yield" },
    });
  }
  return runChatAttempts(executor, async () => {
    bodies.push("llm");
    if (point === "retry_backoff_wait") throw providerFailure("overloaded");
    return { type: "stop" };
  });
}

async function admissionPoint(point: CrashPoint, bodies: string[]) {
  const runtime: SessionRuntime = {
    observations,
    clock: () => 100,
    dispatchOutbound: () => stop(point, bodies),
  };
  const runner = async () => {
    bodies.push("reply");
    return { kind: "result" as const, text: "durable reply" };
  };
  if (point === "inbox_admitted_before_turn_open") {
    session({ id: sessionId, role: "resident", runner }, runtime);
    SessionHandleStore.commitReceivedMessage({
      id: "admitted",
      sessionId,
      kind: "prompt",
      content: "original prompt",
      createdAt: 100,
      origin: { encodingVersion: 1, value: {} },
      parentActionId: null,
    });
    return stop(point, bodies);
  }
  session({ id: "parent", role: "resident", runner }, runtime);
  const commission = SessionHandleStore.commitReceivedMessage({
    id: "commission",
    sessionId: "parent",
    kind: "prompt",
    content: "commission",
    createdAt: 100,
    origin: { encodingVersion: 1, value: {} },
    parentActionId: null,
  });
  const child = session({ id: sessionId, parentId: "parent", role: "worker", runner }, runtime);
  return child.prompt("work", {
    encodingVersion: 1,
    value: {
      kind: "message",
      messageId: "commission",
      senderSessionId: "parent",
      sourceActionId: commission.receipt.action.id,
    },
  });
}

if (import.meta.main) {
  const [point, dbPath] = z.tuple([crashPoint, z.string().min(1)]).parse(process.argv.slice(2));
  Storage.initialize({ dbPath });
  seedPolicy();
  const bodies: string[] = [];
  if (
    point === "inbox_admitted_before_turn_open" ||
    point === "outbound_reply_before_delivery_settle"
  )
    await admissionPoint(point, bodies);
  else await executePoint(point, bodies);
}
