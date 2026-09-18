import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { LedgerAction } from "@openomni/protocol";
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
  crashPoint,
  crashWitness,
  effectOf,
  intentOf,
  matrixSchema,
  observations,
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

async function crash(point: CrashPoint, dbPath: string): Promise<Witness> {
  const child = Bun.spawn([process.execPath, worker, point, dbPath], {
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

test("the authoritative crash matrix names every crash point once", () => {
  expect(matrix.version).toBe(1);
  expect(matrix.rows.map((row) => row.crashPoint).sort()).toEqual([...crashPoint.options].sort());
});

// One test per cell: each cell spawns a child kernel, and under the exact
// coverage collector the eight children together exceed the 15s test budget.
for (const row of matrix.rows) {
  test(`SQLite crash recovery matches the authoritative matrix cell ${row.crashPoint}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "crash-matrix-"));
    try {
      const result = await Storage.withIsolation(async () => {
        const dbPath = join(directory, "kernel.sqlite");
        const witness = await crash(row.crashPoint, dbPath);
        Storage.initialize({ dbPath });
        const persisted = actions();
        Storage.reset();
        Storage.initialize({ dbPath });
        try {
          expect(actions()).toEqual(persisted);
          return row.crashPoint === "turn_intent_before_llm_entry" ||
            row.crashPoint === "inbox_admitted_before_turn_open" ||
            row.crashPoint === "outbound_reply_before_delivery_settle"
            ? await recoverAdmission(witness)
            : await recoverExecutor(witness);
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
