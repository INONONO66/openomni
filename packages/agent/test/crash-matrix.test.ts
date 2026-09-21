import { Effect, Either } from "effect";
import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Alarm, LedgerAction, type Message, SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { renderAnchorText } from "../src/compaction/summary";
import { createExecutor } from "../src/executor";
import { closeSessions, wakeSession, type SessionRuntime } from "../src/session-handle";
import { foldSessionHistory } from "../src/session-lifecycle/history";
import { bounded } from "./helpers/bounded";
import { fiberCrashCell } from "./helpers/fiber-outcome-crash";
import { compiledPolicy } from "./helpers/compiled-policy";
import { countingRunner } from "./helpers/counting-runner";
import { nth } from "./helpers/nth";
import { receiveOutbound } from "./helpers/receive-outbound";
import { requestLedger } from "./helpers/request-ledger";
import {
  checkpointEvidence,
  committedCompactionPoints,
  crashPoint,
  crashWitness,
  effectOf,
  intentOf,
  matrixSchema,
  observations,
  outboundPoints,
  recovery,
  sessionId,
  type CrashPoint,
} from "./helpers/crash-matrix";

const matrix = matrixSchema.parse(
  await Bun.file(new URL("../../../script/conformance/crash-matrix.json", import.meta.url)).json(),
);
const worker = new URL("./helpers/crash-matrix.ts", import.meta.url).pathname;
type Witness = z.infer<typeof crashWitness>;

function actions() {
  return SessionHandleStore.tree(sessionId);
}
function results(kind: LedgerAction.Kind) {
  return actions().filter((action) => action.kind === kind && effectOf(action).phase === "result");
}
function terminalClass(action: LedgerAction.Node) {
  const terminal = z
    .enum(["executed", "failed", "outcome_unknown"])
    .parse(effectOf(action).terminal);
  return {
    executed: "resumed_without_reexecution",
    failed: "not_durable",
    outcome_unknown: "lost",
  }[terminal];
}

// A fresh kernel process loads agent+ledger, opens SQLite and runs one turn;
// on a loaded shared runner that cold start alone has exceeded the 5 s in-process
// bound (#1098). The child's exit is the signal; this is only the failure ceiling.
const SPAWNED_CHILD_MS = 30_000;

async function crash(point: CrashPoint, dbPath: string, stage = "initial"): Promise<Witness> {
  const child = Bun.spawn([process.execPath, worker, point, dbPath, stage], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await bounded(
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      point,
      SPAWNED_CHILD_MS,
    );
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const witness = crashWitness.parse(JSON.parse(stdout));
    expect(witness.crashPoint).toBe(point);
    return witness;
  } finally {
    child.kill();
  }
}

async function recoverExecutor(witness: Witness) {
  const before = actions();
  const history = foldSessionHistory(sessionId, before);
  const recording = requestLedger({ id: sessionId, clock: () => 100_000 });
  const executor = createExecutor({ ...recording, observations, policy: compiledPolicy() });
  await executor.recover();
  expect(actions().slice(0, before.length)).toEqual(before);
  const recovered = actions();
  await executor.recover();
  expect(actions()).toEqual(recovered);
  switch (witness.crashPoint) {
    case "llm_body_before_attempt_result_commit":
      expect(witness.bodies).toEqual(["llm"]);
      expect(witness.pending).toMatchObject({ kind: "attempt", effect: { terminal: "executed" } });
      expect(results("attempt").map(effectOf)).toMatchObject([
        { terminal: "outcome_unknown", recovery: { site: "crash", rawSettled: false } },
      ]);
      return terminalClass(nth(results("llm"), 0));
    case "llm_result_committed":
      expect(witness.bodies).toEqual(["llm"]);
      expect(recovered).toEqual(before);
      expect(results("attempt").map(effectOf)).toMatchObject([{ terminal: "executed" }]);
      return terminalClass(nth(results("llm"), 0));
    case "tool_wave_between_result_commits":
      expect(witness.bodies).toEqual(["first", "second"]);
      expect(
        before.filter((action) => action.kind === "tool" && effectOf(action).phase === "result"),
      ).toHaveLength(1);
      expect(results("tool").map(effectOf)).toMatchObject([
        { terminal: "executed", callId: "first" },
        { terminal: "outcome_unknown", callId: "second", toolResult: { settlement: "unknown" } },
      ]);
      return terminalClass(nth(results("tool"), 1));
    case "compaction_summary_before_result_commit": {
      expect(witness.bodies).toEqual(["summary"]);
      expect(witness.pending).toMatchObject({
        kind: "compaction",
        effect: { result: { summary: "checkpoint" } },
      });
      // The boundary transaction landed before the crash; only the result echo was lost,
      // so the pre-recovery fold still reads the original two-message history.
      expect(history).toHaveLength(2);
      const boundary = before.find(
        (action) => action.kind === "compaction" && effectOf(action).phase === "boundary",
      );
      if (boundary === undefined) throw new Error("missing durable compaction boundary");
      expect(effectOf(boundary)).toMatchObject({ result: { summary: "checkpoint" } });
      const settledResults = results("compaction").map(effectOf);
      expect(settledResults).toMatchObject([
        {
          terminal: "executed",
          recovery: {
            proof: "applied",
            classification: "local_transactional",
            site: "crash",
            proofReceipt: { id: boundary.id },
          },
        },
      ]);
      const { committed, originalAnswer } = checkpointEvidence(
        nth(settledResults, 0).result,
        results("message"),
      );
      const recoveredHistory = foldSessionHistory(sessionId, recovered);
      expect(recoveredHistory).toEqual(committed.projection);
      expectCompactedProjection(recoveredHistory, originalAnswer);
      return terminalClass(nth(results("compaction"), 0));
    }
  }
}

/** Wakes the recovered session once and returns the turn terminals; the pre-crash prefix must be untouched. */
async function wakeAfterCrash(
  witness: Witness,
  runner: ReturnType<typeof countingRunner>,
  runtime: SessionRuntime,
  before: LedgerAction.Node[],
) {
  await bounded(wakeSession(sessionId, runner, runtime), witness.crashPoint);
  expect(actions().slice(0, before.length)).toEqual(before);
  return actions().filter((action) => SessionHandleStore.turnTerminal(action) !== undefined);
}

async function recoverAdmission(witness: Witness) {
  const before = actions();
  const originalTurns = SessionHandleStore.openTurns(before);
  const originalInbox = SessionHandleStore.pendingInbox(sessionId);
  const originalOutbound = SessionHandleStore.outboundRows(sessionId);
  const calls = { model: 0 };
  let deliveries = 0;
  const runtime: SessionRuntime = {
    observations,
    clock: () => 100_000,
    dispatchOutbound: async ({ message }) => {
      deliveries += 1;
      expect([message]).toEqual(originalOutbound.map((item) => item.message));
      return receiveOutbound(message, 100_000).receipt;
    },
  };
  const runner = countingRunner(runtime, calls);
  try {
    const terminals = await wakeAfterCrash(witness, runner, runtime, before);
    expect(terminals).toHaveLength(1);
    if (witness.crashPoint === "outbound_reply_before_delivery_settle") {
      expect(witness.bodies).toEqual(["reply"]);
      expect(originalOutbound).toMatchObject([
        { state: "pending", message: { content: "durable reply" } },
      ]);
      expect(calls.model).toBe(0);
      expect(deliveries).toBe(1);
      expect(SessionHandleStore.outboundRows(sessionId)).toMatchObject([{ state: "delivered" }]);
      const revision = SessionHandleStore.row(sessionId).revision;
      await wakeSession(sessionId, runner, runtime);
      expect(SessionHandleStore.row(sessionId).revision).toBe(revision);
      expect(deliveries).toBe(1);
      return "rearmed";
    }
    expect(witness.bodies).toEqual([]);
    expect(calls.model).toBe(1);
    const terminal = SessionHandleStore.turnTerminal(nth(terminals, 0));
    if (witness.crashPoint === "turn_intent_before_llm_entry") {
      expect(originalTurns).toHaveLength(1);
      expect(terminal?.turnId).toBe(originalTurns[0]?.turnId);
      expect(terminals.map((action) => action.id)).toEqual(
        originalTurns.map((turn) => turn.resultId),
      );
      return "resumed_without_reexecution";
    }
    expect(originalTurns).toEqual([]);
    expect(originalInbox).toMatchObject([{ id: "admitted", content: "original prompt" }]);
    expect(SessionHandleStore.pendingInbox(sessionId)).toEqual([]);
    expect(SessionHandleStore.inboxRows(sessionId)).toHaveLength(1);
    return "rearmed";
  } finally {
    await closeSessions(runtime);
  }
}

async function recoverCommittedCompaction(witness: Witness) {
  const before = actions();
  const inbox = SessionHandleStore.pendingInbox(sessionId);
  expect(witness.bodies).toEqual(["summary"]);
  expect(results("compaction")).toHaveLength(1);
  const result = nth(results("compaction"), 0);
  expect(effectOf(result).terminal).toBe("executed");
  const { committed, originalAnswer } = checkpointEvidence(
    effectOf(result).result,
    results("message"),
  );
  const history = foldSessionHistory(sessionId, before);
  expect(history).toEqual(committed.projection);
  expectCompactedProjection(history, originalAnswer);
  if (witness.crashPoint === "compaction_concurrent_tail_committed_before_owner_crash") {
    expect(inbox.map((item) => item.id)).toEqual(["tail"]);
    expect(SessionHandleStore.inboxRows(sessionId).map((item) => item.id)).toEqual(["tail"]);
  } else expect(inbox).toEqual([]);
  const recording = requestLedger({ id: sessionId, clock: () => 100_000 });
  const executor = createExecutor({ ...recording, observations, policy: compiledPolicy() });
  await executor.recover();
  expect(actions()).toEqual(before);
  const recovered = foldSessionHistory(sessionId, actions());
  expect(recovered).toEqual(history);
  expectCompactedProjection(recovered, originalAnswer);
  expect(SessionHandleStore.pendingInbox(sessionId)).toEqual(inbox);
  await executor.recover();
  expect(actions()).toEqual(before);
  expect(SessionHandleStore.pendingInbox(sessionId)).toEqual(inbox);
  return terminalClass(result);
}

/** Independent of the stored projection: the summary replaced `earlier`, the protected answer survived verbatim. */
function expectCompactedProjection(
  projection: Message.WithParts[],
  originalAnswer: Message.WithParts | undefined,
) {
  const texts = projection.map((message) =>
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  );
  const ids = projection.map((message) => message.info.id);
  expect(ids).not.toContain("earlier");
  expect(new Set(ids).size).toBe(ids.length);
  for (const message of projection) {
    expect(message.parts.map((part) => part.messageID)).toEqual([message.info.id]);
  }
  expect(projection.map((message) => message.parts.map((part) => part.type))).toEqual([
    ["text"],
    ["text"],
  ]);
  expect(texts).toHaveLength(2);
  expect(projection[0]?.info.role).toBe("user");
  expect(texts[0]).toBe(renderAnchorText("checkpoint", false));
  const anchor = nth(projection, 0);
  expect(anchor.parts).toEqual([
    {
      id: nth(anchor.parts, 0).id,
      sessionID: sessionId,
      messageID: nth(ids, 0),
      type: "text",
      text: renderAnchorText("checkpoint", false),
      metadata: {
        compactionAnchor: true,
        anchorBody: "checkpoint",
        keptWindow: [
          { role: "assistant", text: "answer", time: originalAnswer?.info.time.created },
        ],
      },
    },
  ]);
  expect(originalAnswer?.info.id).toBe("answer");
  expect(projection[1]).toEqual(originalAnswer);
  expect(texts[1]).toBe("answer");
}

async function recoverTurn(witness: Witness, resumeCount: number, onModel = () => undefined) {
  const before = actions();
  const original = crashWitness.shape.openTurns.element.parse(witness.openTurns[0]);
  expect(witness.openTurns).toHaveLength(1);
  const calls = { model: 0 };
  const runtime: SessionRuntime = { observations, clock: () => 200_000 };
  const runner = countingRunner(runtime, calls, onModel);
  try {
    const terminals = await wakeAfterCrash(witness, runner, runtime, before);
    expect(terminals.map((action) => action.id)).toEqual([original.resultId]);
    expect(SessionHandleStore.turnTerminal(nth(terminals, 0))).toMatchObject({
      turnId: original.turnId,
      resumeCount,
      kind: "result",
    });
    expect(SessionHandleStore.openTurns(actions())).toEqual([]);
    expect(calls.model).toBe(1);
    const recovered = actions();
    const revision = SessionHandleStore.row(sessionId).revision;
    await bounded(wakeSession(sessionId, runner, runtime), "settled turn wake");
    expect(actions()).toEqual(recovered);
    expect(SessionHandleStore.row(sessionId).revision).toBe(revision);
    expect(calls.model).toBe(1);
    return "resumed_without_reexecution";
  } finally {
    await closeSessions(runtime);
  }
}

async function recoverContinuation(witness: Witness) {
  expect(witness.bodies).toEqual([]);
  expect(witness.openTurns.map((turn) => turn.resumeCount)).toEqual([1]);
  const result = await recoverTurn(witness, 2);
  expect(
    actions()
      .filter((action) => action.kind === "turn" && intentOf(action).phase === "resume")
      .map((action) => ({
        turnId: intentOf(action).turnId,
        resumeCount: intentOf(action).resumeCount,
      })),
  ).toEqual([1, 2].map((resumeCount) => ({ turnId: witness.openTurns[0]?.turnId, resumeCount })));
  return result;
}

/**
 * The committed retry.scheduled alarm survives the crash; the boot alarm owner
 * consumes it exactly once (fenced cancel CAS) and wakes the session, whose open
 * turn re-runs the model attempt exactly once.
 */
async function recoverRetryAlarm(witness: Witness) {
  expect(witness.bodies).toEqual(["llm"]);
  const attempts = actions().filter((action) => action.kind === "attempt");
  expect(attempts.map(intentOf)).toMatchObject([
    { phase: "intent", attempt: 1 },
    { phase: "result" },
  ]);
  const alarmId = `${nth(attempts, 0).id}:retry:1`;
  const armed = actions().find((action) => action.id === alarmId);
  expect(armed).toMatchObject({
    kind: "alarm.arm",
    effect: {
      value: { status: "armed", spec: { kind: "retry.scheduled", attempt: 1, notBefore: 100 } },
    },
  });
  expect(Alarm.RetrySchedule.parse(effectOf(LedgerAction.Node.parse(armed)).spec).reason).toBe(
    "transient_error",
  );
  expect(SessionHandleStore.pendingInbox(sessionId)).toEqual([]);
  // Boot alarm owner: fenced consume-once, then wake. A second consume finds nothing.
  const alarms = Storage.get().alarms;
  const consumed = Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        alarms?.cancel(alarmId, sessionId, 100_000) ??
          Effect.die("missing test storage capability"),
      ),
    ),
    (error) => error,
  );
  expect(consumed).toMatchObject({ id: alarmId, kind: "at", status: "cancelled" });
  expect(() =>
    Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          alarms?.cancel(alarmId, sessionId, 100_000) ??
            Effect.die("missing test storage capability"),
        ),
      ),
      (error) => error,
    ),
  ).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
  expect(await recoverTurn(witness, 1)).toBe("resumed_without_reexecution");
  // The wake injected no prompt and the completed attempt armed nothing new.
  expect(SessionHandleStore.pendingInbox(sessionId)).toEqual([]);
  expect(
    actions().filter((action) => action.kind === "alarm.arm" && action.id.includes(":retry:")),
  ).toHaveLength(1);
  return "rearmed";
}

async function recoverStaleOwner(witness: Witness) {
  expect(witness.bodies).toEqual(["llm"]);
  const staleAction = LedgerAction.Append.parse(witness.staleAction);
  expect(staleAction.kind).toBe("attempt");
  expect(effectOf(staleAction)).toMatchObject({ phase: "result", terminal: "executed" });
  const owner = z.string().parse(witness.lease.owner);
  const expiresAt = z.number().parse(witness.lease.expiresAt);
  expect(expiresAt).toBe(100 + SessionHandleStore.LEASE_TTL_MS);
  let refusals = 0;
  await recoverTurn(witness, 1, () => {
    const current = SessionHandleStore.row(sessionId);
    expect(current.leaseOwner).not.toBe(owner);
    expect(current.leaseFence).toBeGreaterThan(witness.lease.fence);
    expect(200_000).toBeGreaterThan(expiresAt);
    const before = actions();
    const refused = () =>
      Either.getOrThrowWith(
        Effect.runSync(
          Effect.either(
            SessionHandleStore.commit({
              sessionId,
              owner,
              fence: witness.lease.fence,
              now: 200_000,
              expectedRevision: current.revision,
              actions: [staleAction],
              consumeInboxIds: [],
              state: current.state,
              releaseLease: false,
            }),
          ),
        ),
        (error) => error,
      );
    expect(refused).toThrow(expect.objectContaining({ _tag: "CommitRefused", reason: "fence" }));
    expect(actions()).toEqual(before);
    expect(SessionHandleStore.row(sessionId)).toEqual(current);
    refusals += 1;
    return undefined;
  });
  expect(refusals).toBe(1);
  // The typed rejection is atomic: the stale writer's effect row never appears.
  expect(actions().some((action) => action.id === staleAction.id)).toBe(false);
  return "rejected";
}

function assertOutboundCut(witness: Witness) {
  const outbound = SessionHandleStore.outboundRows(sessionId);
  expect(outbound).toHaveLength(1);
  const item = SessionTransition.Outbound.parse(outbound[0]);
  const acked = witness.crashPoint === "delivery_ack_committed_before_owner_cleanup";
  const sent =
    acked || witness.crashPoint === "platform_send_committed_before_local_ack_reconciled_sent";
  const accepted = sent || witness.crashPoint === "platform_send_ambiguous_without_reconciliation";
  const extra =
    witness.crashPoint === "outbound_flood_deadline_before_timer_rearm" ? ["flood"] : [];
  expect(witness.bodies).toEqual(["reply", ...(accepted ? ["accepted"] : extra)]);
  expect(item.state).toBe(acked ? "delivered" : "pending");
  expect(item.message.content).toBe("durable reply");
  const destination = SessionHandleStore.inboxRows(item.message.destinationSessionId).filter(
    (row) => row.id === item.message.messageId,
  );
  expect(destination).toHaveLength(sent ? 1 : 0);
  const openId = `${item.message.sourceActionId}:outbound`;
  const openIndex = actions().findIndex((action) => action.id === openId);
  expect(openIndex).toBeGreaterThanOrEqual(0);
  // In particular C5 has no attempt/marker action of any kind after its open row.
  expect(
    actions()
      .slice(openIndex + 1)
      .map((action) => action.id),
  ).toEqual(acked ? [`${item.message.messageId}:ack`] : []);
  return { item, acked, destination };
}

function reclaimAcknowledgedLease(witness: Witness) {
  const row = SessionHandleStore.row(sessionId);
  expect(row.leaseOwner).toBe(witness.lease.owner);
  expect(row.leaseFence).toBe(witness.lease.fence);
  expect(z.number().parse(row.leaseExpiresAt)).toBeLessThan(200_000);
  const owner = "cleanup-owner";
  const lease = Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        SessionHandleStore.acquireLease({
          sessionId,
          owner,
          expectedFence: row.leaseFence,
          now: 200_000,
          expiresAt: 200_000 + SessionHandleStore.LEASE_TTL_MS,
        }),
      ),
    ),
    (error) => error,
  );
  expect(lease.ok).toBe(true);
  if (!lease.ok) throw new Error("acknowledged lease was not reacquirable");
  expect(
    Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          SessionHandleStore.commit({
            sessionId,
            owner,
            fence: lease.fence,
            now: 200_000,
            expectedRevision: row.revision,
            actions: [],
            consumeInboxIds: [],
            state: row.state,
            releaseLease: true,
          }),
        ),
      ),
      (error) => error,
    ).ok,
  ).toBe(true);
  expect(SessionHandleStore.row(sessionId).leaseOwner).toBeNull();
}

async function recoverOutbound(witness: Witness, dbPath: string) {
  const before = actions();
  const { item, acked, destination } = assertOutboundCut(witness);
  const external = witness.crashPoint === "platform_send_ambiguous_without_reconciliation";
  const platformPath = `${dbPath}.platform`;
  if (external) expect(readFileSync(platformPath, "utf8")).toBe(`${item.message.messageId}\n`);
  let deliveries = 0;
  const calls = { model: 0 };
  const runtime: SessionRuntime = {
    observations,
    clock: () => 200_000,
    dispatchOutbound: async ({ message }) => {
      deliveries += 1;
      expect(message).toEqual(item.message);
      if (external) appendFileSync(platformPath, `${message.messageId}\n`);
      return receiveOutbound(message, 200_000).receipt;
    },
  };
  const runner = countingRunner(runtime, calls);
  try {
    await wakeAfterCrash(witness, runner, runtime, before);
    expect(calls.model).toBe(0);
    expect(deliveries).toBe(acked ? 0 : 1);
    expect(SessionHandleStore.outboundRows(sessionId)).toMatchObject([
      { state: "delivered", message: item.message },
    ]);
    const received = SessionHandleStore.inboxRows(item.message.destinationSessionId).filter(
      (row) => row.id === item.message.messageId,
    );
    expect(received).toHaveLength(1);
    if (destination.length === 1) expect(received).toEqual(destination);
    expect(
      actions().filter((action) => SessionHandleStore.turnTerminal(action) !== undefined),
    ).toHaveLength(1);
    if (acked) reclaimAcknowledgedLease(witness);
    expect(SessionHandleStore.row(sessionId).leaseOwner).toBeNull();
    const revision = SessionHandleStore.row(sessionId).revision;
    const recovered = actions();
    await bounded(wakeSession(sessionId, runner, runtime), "settled outbound wake");
    expect(SessionHandleStore.row(sessionId).revision).toBe(revision);
    expect(actions()).toEqual(recovered);
    expect(deliveries).toBe(acked ? 0 : 1);
    expect(calls.model).toBe(0);
    if (external)
      expect(readFileSync(platformPath, "utf8")).toBe(
        `${item.message.messageId}\n${item.message.messageId}\n`,
      );
    if (acked) return "resumed_without_reexecution";
    return external || destination.length === 1 ? "replayed" : "rearmed";
  } finally {
    await closeSessions(runtime);
  }
}

async function recoverCell(witness: Witness, dbPath: string) {
  if (committedCompactionPoints.has(witness.crashPoint)) return recoverCommittedCompaction(witness);
  if (witness.crashPoint === "outbound_reply_before_delivery_settle")
    return recoverAdmission(witness);
  if (outboundPoints.has(witness.crashPoint)) return recoverOutbound(witness, dbPath);
  switch (witness.crashPoint) {
    case "recovery_dispatch_identity_committed_before_rpc":
      return recoverContinuation(witness);
    case "retry_backoff_wait":
      return recoverRetryAlarm(witness);
    case "owner_reclaimed_before_stale_transcript_flush":
      return recoverStaleOwner(witness);
    case "turn_intent_before_llm_entry":
    case "inbox_admitted_before_turn_open":
      return recoverAdmission(witness);
    default:
      return recoverExecutor(witness);
  }
}

async function crashCell(point: CrashPoint, dbPath: string) {
  const initial = await crash(point, dbPath);
  if (point !== "recovery_dispatch_identity_committed_before_rpc") return initial;
  expect(initial.bodies).toEqual([]);
  expect(initial.openTurns).toHaveLength(1);
  expect(initial.openTurns[0]?.resumeCount).toBe(0);
  const resumed = await crash(point, dbPath, "resume");
  expect(resumed.openTurns).toEqual(initial.openTurns.map((turn) => ({ ...turn, resumeCount: 1 })));
  return resumed;
}

test("the authoritative crash matrix names every crash point once", () => {
  expect(matrix.version).toBe(2);
  expect(matrix.rows.map((row) => row.crashPoint).sort()).toEqual([...crashPoint.options].sort());
});

// One test per cell: each cell spawns a child kernel (two for the resumed
// continuation), and under the exact coverage collector the seventeen children
// together exceed one test budget.
for (const row of matrix.rows) {
  test(`SQLite crash recovery matches the authoritative matrix cell ${row.crashPoint}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "crash-matrix-"));
    try {
      const result = await Storage.withIsolation(async () => {
        const dbPath = join(directory, "kernel.sqlite");
        if (row.crashPoint === "fiber_exit_after_execute_before_action_commit")
          return fiberCrashCell(dbPath);
        const witness = await crashCell(row.crashPoint, dbPath);
        Storage.initialize({ dbPath });
        const persisted = actions();
        Storage.reset();
        Storage.initialize({ dbPath });
        try {
          expect(actions()).toEqual(persisted);
          return await recoverCell(witness, dbPath);
        } finally {
          Storage.reset();
        }
      });
      expect(recovery.parse(result)).toBe(row.recovery);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
