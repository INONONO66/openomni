import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { LedgerAction, Message, SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { createExecutor } from "../src/executor";
import { closeSessions, wakeSession, type SessionRuntime } from "../src/session-handle";
import { foldSessionHistory } from "../src/session-lifecycle/history";
import { bounded } from "./helpers/bounded";
import { compiledPolicy } from "./helpers/compiled-policy";
import { dispatchingRunner } from "./helpers/dispatching-runner";
import { completeModel } from "./helpers/mock-llm";
import { nth } from "./helpers/nth";
import { receiveOutbound } from "./helpers/receive-outbound";
import { requestLedger } from "./helpers/request-ledger";
import {
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
    case "retry_backoff_wait":
      expect(witness.bodies).toEqual(["llm"]);
      expect(before.filter((action) => action.kind === "attempt").map(intentOf)).toMatchObject([
        { phase: "intent", attempt: 1 },
        { phase: "result" },
      ]);
      expect(SessionHandleStore.pendingInbox(sessionId)).toEqual([]);
      expect(SessionHandleStore.requestRows()).toEqual([]);
      expect(results("llm").map(effectOf)).toMatchObject([
        { terminal: "failed", recovery: { proof: "absent", site: "crash" } },
      ]);
      expect(results("attempt")).toEqual(
        before.filter((action) => action.kind === "attempt" && effectOf(action).phase === "result"),
      );
      return terminalClass(nth(results("llm"), 0));
    case "compaction_summary_before_result_commit":
      expect(witness.bodies).toEqual(["summary"]);
      expect(witness.pending).toMatchObject({
        kind: "compaction",
        effect: { result: { summary: "checkpoint" } },
      });
      expect(history).toHaveLength(2);
      expect(foldSessionHistory(sessionId, recovered)).toEqual(history);
      expect(results("compaction").map(effectOf)).toMatchObject([
        {
          terminal: "failed",
          recovery: { proof: "absent", classification: "local_transactional" },
        },
      ]);
      return terminalClass(nth(results("compaction"), 0));
  }
}

async function recoverAdmission(witness: Witness) {
  const before = actions();
  const originalTurns = SessionHandleStore.openTurns(before);
  const originalInbox = SessionHandleStore.pendingInbox(sessionId);
  const originalOutbound = SessionHandleStore.outboundRows(sessionId);
  let modelCalls = 0;
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
  const runner = dispatchingRunner(
    [],
    () => runtime,
    async (input, sink) => {
      modelCalls += 1;
      return completeModel(input, sink);
    },
  );
  try {
    await bounded(wakeSession(sessionId, runner, runtime), witness.crashPoint);
    expect(actions().slice(0, before.length)).toEqual(before);
    const terminals = actions().filter(
      (action) => SessionHandleStore.turnTerminal(action) !== undefined,
    );
    expect(terminals).toHaveLength(1);
    if (witness.crashPoint === "outbound_reply_before_delivery_settle") {
      expect(witness.bodies).toEqual(["reply"]);
      expect(originalOutbound).toMatchObject([
        { state: "pending", message: { content: "durable reply" } },
      ]);
      expect(modelCalls).toBe(0);
      expect(deliveries).toBe(1);
      expect(SessionHandleStore.outboundRows(sessionId)).toMatchObject([{ state: "delivered" }]);
      const revision = SessionHandleStore.row(sessionId).revision;
      await wakeSession(sessionId, runner, runtime);
      expect(SessionHandleStore.row(sessionId).revision).toBe(revision);
      expect(deliveries).toBe(1);
      return "rearmed";
    }
    expect(witness.bodies).toEqual([]);
    expect(modelCalls).toBe(1);
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
  const committed = z
    .object({
      summary: z.literal("checkpoint"),
      projection: z.array(Message.WithParts),
    })
    .parse(effectOf(result).result);
  const originalAnswer = z
    .array(Message.WithParts)
    .parse(results("message").map((action) => effectOf(action).result))
    .find((message) => message.info.id === "answer");
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
  expect(projection.map((message) => message.info.id)).not.toContain("earlier");
  expect(projection.map((message) => message.parts.map((part) => part.type))).toEqual([
    ["text"],
    ["text"],
  ]);
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain("checkpoint");
  expect(texts[0]).not.toContain("earlier evidence");
  expect(originalAnswer?.info.id).toBe("answer");
  expect(projection[1]).toEqual(originalAnswer);
  expect(texts[1]).toBe("answer");
}

async function recoverTurn(witness: Witness, resumeCount: number, onModel = () => undefined) {
  const before = actions();
  const original = crashWitness.shape.openTurns.element.parse(witness.openTurns[0]);
  expect(witness.openTurns).toHaveLength(1);
  let modelCalls = 0;
  const runtime: SessionRuntime = { observations, clock: () => 200_000 };
  const runner = dispatchingRunner(
    [],
    () => runtime,
    async (input, sink) => {
      onModel();
      modelCalls += 1;
      return completeModel(input, sink);
    },
  );
  try {
    await bounded(wakeSession(sessionId, runner, runtime), witness.crashPoint);
    expect(actions().slice(0, before.length)).toEqual(before);
    const terminals = actions().filter(
      (action) => SessionHandleStore.turnTerminal(action) !== undefined,
    );
    expect(terminals.map((action) => action.id)).toEqual([original.resultId]);
    expect(SessionHandleStore.turnTerminal(nth(terminals, 0))).toMatchObject({
      turnId: original.turnId,
      resumeCount,
      kind: "result",
    });
    expect(SessionHandleStore.openTurns(actions())).toEqual([]);
    expect(modelCalls).toBe(1);
    const recovered = actions();
    const revision = SessionHandleStore.row(sessionId).revision;
    await bounded(wakeSession(sessionId, runner, runtime), "settled turn wake");
    expect(actions()).toEqual(recovered);
    expect(SessionHandleStore.row(sessionId).revision).toBe(revision);
    expect(modelCalls).toBe(1);
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
    const refused = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: witness.lease.fence,
      now: 200_000,
      expectedRevision: current.revision,
      actions: [staleAction],
      consumeInboxIds: [],
      state: current.state,
      releaseLease: false,
    });
    expect(refused).toMatchObject({ ok: false, reason: "stale" });
    expect(actions()).toEqual(before);
    expect(SessionHandleStore.row(sessionId)).toEqual(current);
    refusals += 1;
    return undefined;
  });
  expect(refusals).toBe(1);
  expect(actions().some((action) => action.id === staleAction.id)).toBe(false);
  return "lost";
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
  const lease = SessionHandleStore.acquireLease({
    sessionId,
    owner,
    expectedFence: row.leaseFence,
    now: 200_000,
    expiresAt: 200_000 + SessionHandleStore.LEASE_TTL_MS,
  });
  expect(lease.ok).toBe(true);
  if (!lease.ok) throw new Error("acknowledged lease was not reacquirable");
  expect(
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
    }).ok,
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
  let modelCalls = 0;
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
  const runner = dispatchingRunner(
    [],
    () => runtime,
    async (input, sink) => {
      modelCalls += 1;
      return completeModel(input, sink);
    },
  );
  try {
    await bounded(wakeSession(sessionId, runner, runtime), witness.crashPoint);
    expect(actions().slice(0, before.length)).toEqual(before);
    expect(modelCalls).toBe(0);
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
    expect(modelCalls).toBe(0);
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

test("SQLite crash recovery matches every authoritative matrix cell", async () => {
  expect(matrix.rows.map((row) => row.crashPoint).sort()).toEqual([...crashPoint.options].sort());
  const observed: z.infer<typeof matrixSchema> = { version: 2, rows: [] };
  for (const row of matrix.rows) {
    const directory = mkdtempSync(join(tmpdir(), "crash-matrix-"));
    try {
      const result = await Storage.withIsolation(async () => {
        const dbPath = join(directory, "kernel.sqlite");
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
      observed.rows.push({ ...row, recovery: recovery.parse(result) });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  expect(observed).toEqual(matrix);
}, 30_000);
