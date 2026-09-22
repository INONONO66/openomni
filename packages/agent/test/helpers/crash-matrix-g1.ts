import { Effect } from "effect";
import { appendFileSync, writeSync } from "node:fs";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  type LedgerAction,
  PlainValueSchema,
} from "@openomni/protocol";
import { z } from "zod";
import { createExecutor, type ExecutionLedger } from "../../src/executor";
import { createRetryAlarmPort } from "../../src/executor-retry-alarm";
import { executeCompaction } from "../../src/compaction/execute-cut";
import { session, wakeSession, type SessionRuntime } from "../../src/session-handle";
import { receiveOutbound } from "./effect-g2";
import { createTurnDispatcher } from "../../src/tool-dispatcher";
import { requestLedger } from "./effect-g1";
import { compiledPolicy } from "./compiled-policy";
import { runChatAttempts } from "./effect-g1";
import { providerFailure } from "./mock-llm";
import { stringQueryTool } from "./query-tool";
import { textMessage } from "./messages";
import { seedPolicy } from "./seed-policy";

import { isolated } from "./isolated";
import { ForeignFailure } from "../../src/errors";
import { crashPoint, crashWitness, sessionId, observations, effectOf, committedCompactionPoints, outboundPoints, type CrashPoint } from "./crash-matrix";
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
    commit(action: LedgerAction.Append) {
      return Effect.gen(function* () {
      const result = effectOf(action).phase === "result";
      if (action.kind === "tool" && result) toolResults += 1;
      if (beforeResult(point, action, toolResults)) return stop(point, bodies, action);
      const receipt = yield* ledger.commit(action);
      const after =
        (point === "llm_result_committed" && action.kind === "llm") ||
        (committedCompactionPoints.has(point) && action.kind === "compaction");
      if (after && result) return stop(point, bodies, action);
      return receipt;
      });
    },
  };
}

function executePoint(point: CrashPoint, bodies: string[]) {
  return Effect.gen(function* () {
  const recording = yield* requestLedger({ id: sessionId });
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
    return yield* dispatcher.executeWave(
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
      yield* executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () => Effect.succeed(PlainValueSchema.parse(message)),
      );
    }
    return yield* executeCompaction({
      history,
      executor,
      events: observations,
      options: {
        contextWindowTokens: 10_000,
        protectRecentMessages: 1,
        onSummarize: () => Effect.gen(function* () {
          bodies.push("summary");
          if (point === "compaction_concurrent_tail_committed_before_owner_crash") {
            (yield* SessionHandleStore.commitReceivedMessage({
                    id: "tail",
                    sessionId,
                    kind: "prompt",
                    content: "concurrent tail",
                    createdAt: 100,
                    origin: { encodingVersion: 1, value: {} },
                    parentActionId: null,
                  }));
          }
          return "checkpoint";
        }),
      },
      identity: { traceId: "crash", sessionId },
      dispatch: { trigger: "yield" },
    });
  }
  return yield* runChatAttempts(executor, () => Effect.gen(function* () {
    bodies.push("llm");
    if (point === "retry_backoff_wait") return yield* providerFailure("overloaded");
    return { type: "stop" };
  }));
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
  return ({ message }) => Effect.gen(function* () {
    if (point === "outbound_flood_deadline_before_timer_rearm") {
      bodies.push("flood");
      return yield* new ForeignFailure({ operation: "outbound.flood", cause: "flood" });
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
      const { receipt } = yield* receiveOutbound(message, 100);
      bodies.push("accepted");
      if (point === "platform_send_committed_before_local_ack_reconciled_sent") stop(point, bodies);
      return receipt;
    }
    return stop(point, bodies);
  });
}

function admissionPoint(point: CrashPoint, bodies: string[], dbPath: string) {
  return Effect.gen(function* () {
  const runtime: SessionRuntime = {
    observations,
    clock: () => workerClock(point, bodies),
    dispatchOutbound: outboundPort(point, bodies, dbPath),
  };
  const runner = () => Effect.sync(() => {
    bodies.push("reply");
    return { kind: "result" as const, text: "durable reply" };
  });
  if (point === "inbox_admitted_before_turn_open") {
    yield* session({ id: sessionId, role: "resident", runner }, runtime);
    (yield* SessionHandleStore.commitReceivedMessage({
            id: "admitted",
            sessionId,
            kind: "prompt",
            content: "original prompt",
            createdAt: 100,
            origin: { encodingVersion: 1, value: {} },
            parentActionId: null,
          }));
    return stop(point, bodies);
  }
  yield* session({ id: "parent", role: "resident", runner }, runtime);
  const commission = (yield* SessionHandleStore.commitReceivedMessage({
          id: "commission",
          sessionId: "parent",
          kind: "prompt",
          content: "commission",
          createdAt: 100,
          origin: { encodingVersion: 1, value: {} },
          parentActionId: null,
        }));
  const child = yield* session({ id: sessionId, parentId: "parent", role: "worker", runner }, runtime);
  return yield* child
    .prompt("work", {
      encodingVersion: 1,
      value: {
        kind: "message",
        messageId: "commission",
        senderSessionId: "parent",
        sourceActionId: commission.receipt.action.id,
      },
    })
    .pipe(Effect.catchAll((error) => {
      if (point !== "outbound_flood_deadline_before_timer_rearm") return Effect.fail(error);
      if (error._tag !== "ForeignFailure" || error.operation !== "outbound.flood") return Effect.fail(error);
      return Effect.sync(() => stop(point, bodies));
    }));
  });
}

if (import.meta.main) {
  const [point, dbPath, stage] = z
    .tuple([crashPoint, z.string().min(1), z.enum(["initial", "resume"])])
    .parse(process.argv.slice(2));
  await isolated(Effect.scoped(Effect.gen(function* () {
    Storage.reset();
    Storage.initialize({ dbPath });
    seedPolicy();
    const bodies: string[] = [];
    if (stage === "resume") {
      yield* wakeSession(sessionId, () => Effect.sync(() => stop(point, bodies)), {
        observations, clock: () => 100_000,
      });
    } else if (point === "inbox_admitted_before_turn_open" || outboundPoints.has(point)) {
      yield* admissionPoint(point, bodies, dbPath);
    } else yield* executePoint(point, bodies);
  })));
}
