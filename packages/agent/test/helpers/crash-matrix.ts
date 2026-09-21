import { Effect, Either } from "effect";
import { appendFileSync, writeSync } from "node:fs";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  LedgerAction,
  Message,
  PlainObjectSchema,
  PlainValueSchema,
  type PlainValue,
} from "@openomni/protocol";
import { z } from "zod";
import { createExecutor, type ExecutionLedger } from "../../src/executor";
import { createRetryAlarmPort } from "../../src/executor-retry-alarm";
import { executeCompaction } from "../../src/compaction/execute-cut";
import { session, wakeSession, type SessionRuntime } from "../../src/session-handle";
import { receiveOutbound } from "./receive-outbound";
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
  "fiber_exit_after_execute_before_action_commit",
  "llm_result_committed",
  "tool_wave_between_result_commits",
  "retry_backoff_wait",
  "compaction_summary_before_result_commit",
  "inbox_admitted_before_turn_open",
  "outbound_reply_before_delivery_settle",
  "recovery_dispatch_identity_committed_before_rpc",
  "compaction_boundary_committed_before_publication",
  "delivery_ack_committed_before_owner_cleanup",
  "platform_send_committed_before_local_ack_reconciled_sent",
  "platform_attempt_marker_before_send_reconciled_not_sent",
  "platform_send_ambiguous_without_reconciliation",
  "compaction_concurrent_tail_committed_before_owner_crash",
  "outbound_flood_deadline_before_timer_rearm",
  "owner_reclaimed_before_stale_transcript_flush",
]);
export const recovery = z.enum([
  "resumed_without_reexecution",
  "replayed",
  "rearmed",
  "not_durable",
  "rejected",
  "lost",
]);
export const matrixSchema = z
  .object({
    version: z.literal(2),
    rows: z.array(z.object({ crashPoint, recovery, note: z.string().min(1) }).strict()).min(17),
  })
  .strict();
export const crashWitness = z
  .object({
    crashPoint,
    bodies: z.array(z.string()),
    pending: z.object({ kind: z.string(), effect: PlainObjectSchema }).optional(),
    staleAction: LedgerAction.Append.optional(),
    lease: z.object({
      owner: z.string().nullable(),
      fence: z.number(),
      expiresAt: z.number().nullable(),
    }),
    openTurns: z.array(
      z.object({ turnId: z.string(), resultId: z.string(), resumeCount: z.number() }),
    ),
  })
  .strict();
export type CrashPoint = z.infer<typeof crashPoint>;
export const sessionId = "crash-session";
export const observations = { publish: () => undefined };
export const effectOf = (action: LedgerAction.Append) =>
  PlainObjectSchema.parse(action.effect.value);
export const intentOf = (action: LedgerAction.Append) =>
  PlainObjectSchema.parse(action.intent.value);

/** The committed checkpoint payload and the protected original answer, schema-typed. */
export function checkpointEvidence(
  result: PlainValue | undefined,
  messageResults: readonly LedgerAction.Append[],
) {
  const committed = z
    .object({ summary: z.literal("checkpoint"), projection: z.array(Message.WithParts) })
    .parse(result);
  const originalAnswer = z
    .array(Message.WithParts)
    .parse(messageResults.map((action) => effectOf(action).result))
    .find((message) => message.info.id === "answer");
  return { committed, originalAnswer };
}

export const outboundPoints = new Set<CrashPoint>([
  "outbound_reply_before_delivery_settle",
  "delivery_ack_committed_before_owner_cleanup",
  "platform_send_committed_before_local_ack_reconciled_sent",
  "platform_attempt_marker_before_send_reconciled_not_sent",
  "platform_send_ambiguous_without_reconciliation",
  "outbound_flood_deadline_before_timer_rearm",
]);
export const committedCompactionPoints = new Set<CrashPoint>([
  "compaction_boundary_committed_before_publication",
  "compaction_concurrent_tail_committed_before_owner_crash",
]);

// Synchronous witness output also permits cuts inside the synchronous store commit port.
function stop(point: CrashPoint, bodies: string[], pending?: LedgerAction.Append): never {
  const row = SessionHandleStore.row(sessionId);
  const witness = crashWitness.parse({
    crashPoint: point,
    bodies,
    lease: { owner: row.leaseOwner, fence: row.leaseFence, expiresAt: row.leaseExpiresAt },
    openTurns: SessionHandleStore.openTurns(SessionHandleStore.tree(sessionId)),
    ...(pending === undefined
      ? {}
      : { pending: { kind: pending.kind, effect: pending.effect.value } }),
    ...(point === "owner_reclaimed_before_stale_transcript_flush" ? { staleAction: pending } : {}),
  });
  writeSync(1, `${JSON.stringify(witness)}\n`);
  process.exit(0);
}

function beforeResult(point: CrashPoint, action: LedgerAction.Append, toolResults: number) {
  if (effectOf(action).phase !== "result") return false;
  switch (point) {
    case "llm_body_before_attempt_result_commit":
    case "owner_reclaimed_before_stale_transcript_flush":
      return action.kind === "attempt";
    case "tool_wave_between_result_commits":
      return action.kind === "tool" && toolResults === 2;
    case "compaction_summary_before_result_commit":
      return action.kind === "compaction";
    default:
      return false;
  }
}

function intercept(ledger: ExecutionLedger, point: CrashPoint, bodies: string[]): ExecutionLedger {
  let toolResults = 0;
  return {
    ...ledger,
    async commit(action) {
      const result = effectOf(action).phase === "result";
      if (action.kind === "tool" && result) toolResults += 1;
      if (beforeResult(point, action, toolResults)) return stop(point, bodies, action);
      const receipt = await ledger.commit(action);
      const after =
        (point === "llm_result_committed" && action.kind === "llm") ||
        (committedCompactionPoints.has(point) && action.kind === "compaction");
      if (after && result) return stop(point, bodies, action);
      return receipt;
    },
  };
}

async function executePoint(point: CrashPoint, bodies: string[]) {
  const recording = requestLedger({ id: sessionId });
  if (
    point === "turn_intent_before_llm_entry" ||
    point === "recovery_dispatch_identity_committed_before_rpc"
  )
    return stop(point, bodies);
  const ledger = intercept(recording.ledger, point, bodies);
  const executor = createExecutor({
    ...recording,
    ledger,
    policy: compiledPolicy(),
    observations,
    // The durable arm commits before the cut: only the wait itself is lost.
    retryAlarm: {
      ...createRetryAlarmPort(sessionId, recording.clock),
      wait: () => stop(point, bodies),
    },
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
  if (point === "compaction_summary_before_result_commit" || committedCompactionPoints.has(point)) {
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
          if (point === "compaction_concurrent_tail_committed_before_owner_crash") {
            Either.getOrThrowWith(
              Effect.runSync(
                Effect.either(
                  SessionHandleStore.commitReceivedMessage({
                    id: "tail",
                    sessionId,
                    kind: "prompt",
                    content: "concurrent tail",
                    createdAt: 100,
                    origin: { encodingVersion: 1, value: {} },
                    parentActionId: null,
                  }),
                ),
              ),
              (error) => error,
            );
          }
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

function workerClock(point: CrashPoint, bodies: string[]) {
  // dispatchSessionOutbound reads the clock for commit([], true) after committing the ACK.
  if (
    point === "delivery_ack_committed_before_owner_cleanup" &&
    bodies.includes("accepted") &&
    SessionHandleStore.outboundRows(sessionId).some((item) => item.state === "delivered")
  )
    stop(point, bodies);
  return 100;
}

function outboundPort(
  point: CrashPoint,
  bodies: string[],
  dbPath: string,
): SessionRuntime["dispatchOutbound"] {
  return async ({ message }) => {
    if (point === "outbound_flood_deadline_before_timer_rearm") {
      bodies.push("flood");
      throw new Error("flood");
    }
    if (point === "platform_send_ambiguous_without_reconciliation") {
      appendFileSync(`${dbPath}.platform`, `${message.messageId}\n`);
      bodies.push("accepted");
      return stop(point, bodies);
    }
    if (
      point === "delivery_ack_committed_before_owner_cleanup" ||
      point === "platform_send_committed_before_local_ack_reconciled_sent"
    ) {
      const { receipt } = receiveOutbound(message, 100);
      bodies.push("accepted");
      if (point === "platform_send_committed_before_local_ack_reconciled_sent") stop(point, bodies);
      return receipt;
    }
    return stop(point, bodies);
  };
}

async function admissionPoint(point: CrashPoint, bodies: string[], dbPath: string) {
  const runtime: SessionRuntime = {
    observations,
    clock: () => workerClock(point, bodies),
    dispatchOutbound: outboundPort(point, bodies, dbPath),
  };
  const runner = async () => {
    bodies.push("reply");
    return { kind: "result" as const, text: "durable reply" };
  };
  if (point === "inbox_admitted_before_turn_open") {
    session({ id: sessionId, role: "resident", runner }, runtime);
    Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          SessionHandleStore.commitReceivedMessage({
            id: "admitted",
            sessionId,
            kind: "prompt",
            content: "original prompt",
            createdAt: 100,
            origin: { encodingVersion: 1, value: {} },
            parentActionId: null,
          }),
        ),
      ),
      (error) => error,
    );
    return stop(point, bodies);
  }
  session({ id: "parent", role: "resident", runner }, runtime);
  const commission = Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        SessionHandleStore.commitReceivedMessage({
          id: "commission",
          sessionId: "parent",
          kind: "prompt",
          content: "commission",
          createdAt: 100,
          origin: { encodingVersion: 1, value: {} },
          parentActionId: null,
        }),
      ),
    ),
    (error) => error,
  );
  const child = session({ id: sessionId, parentId: "parent", role: "worker", runner }, runtime);
  return child
    .prompt("work", {
      encodingVersion: 1,
      value: {
        kind: "message",
        messageId: "commission",
        senderSessionId: "parent",
        sourceActionId: commission.receipt.action.id,
      },
    })
    .catch((error: Error) => {
      if (point !== "outbound_flood_deadline_before_timer_rearm") throw error;
      if (z.instanceof(Error).parse(error).message !== "flood") throw error;
      return stop(point, bodies);
    });
}

if (import.meta.main) {
  const [point, dbPath, stage] = z
    .tuple([crashPoint, z.string().min(1), z.enum(["initial", "resume"])])
    .parse(process.argv.slice(2));
  Storage.initialize({ dbPath });
  seedPolicy();
  const bodies: string[] = [];
  if (stage === "resume") {
    await wakeSession(sessionId, async () => stop(point, bodies), {
      observations,
      clock: () => 100_000,
    });
  } else if (point === "inbox_admitted_before_turn_open" || outboundPoints.has(point)) {
    await admissionPoint(point, bodies, dbPath);
  } else await executePoint(point, bodies);
}
