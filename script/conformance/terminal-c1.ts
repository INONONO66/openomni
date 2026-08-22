#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkItem } from "../../packages/protocol/src/index";
import {
  BusQuery,
  EffectStore,
  Session,
  SqliteStorageAdapter,
  Storage,
  WorkItemAttemptRun,
  WorkItemStore,
} from "../../packages/ledger/src/index";
import { VerifierRegistry } from "../../packages/openomni/src/evidence/verifier-registry";
import { assembleEffectRuntime } from "../../apps/server/src/bootstrap/effects";
import { recoverInterruptedRuns } from "../../apps/server/src/execution/recovery";

const ROOT = resolve(import.meta.dir, "../..");
const DRIVER = join(ROOT, "apps/server/src/manual/ipc-worker-driver.ts");

type ChildReceipt = Readonly<Record<string, unknown>>;
type SpawnReceipt = Readonly<{ pid: number; command: string[]; receipt: ChildReceipt }>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function closeStorage(): void {
  const adapter = Storage.getAdapter();
  if (adapter instanceof SqliteStorageAdapter) adapter.close();
  Storage.reset();
}

function attemptIdentity(prompt: string) {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput: prompt,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true as const, reason: "terminal C1 fixture" },
      model: {
        provider: "terminal-c1",
        id: "no-network",
        parameters: { absent: true as const, reason: "terminal C1 fixture" },
      },
      upstreamFingerprints: { absent: true as const, reason: "terminal C1 fixture" },
      dependencyLock: { absent: true as const, reason: "terminal C1 fixture" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun ?? process.version,
      workspaceRoot: { absent: true as const, reason: "terminal C1 fixture" },
      schemaVersions: { policyKernel: 1 },
      policy: { absent: true as const, reason: "terminal C1 fixture" },
      toolVersions: { absent: true as const, reason: "terminal C1 fixture" },
      verifierVersions: { absent: true as const, reason: "terminal C1 fixture" },
      providerParameters: { absent: true as const, reason: "terminal C1 fixture" },
      configRef: { absent: true as const, reason: "terminal C1 fixture" },
    }),
  };
}

async function seedRestart(dbPath: string): Promise<ChildReceipt> {
  Storage.initialize({ dbPath });
  const session = Session.create({
    traceId: "trace-terminal-c1",
    title: "terminal C1 restart",
    model: { providerID: "terminal-c1", modelID: "no-network" },
  });
  const item = await WorkItemStore.create(
    {
      name: "terminal C1 interrupted run",
      sourceMessageId: "terminal-c1-source",
      sourceChannel: "conformance",
      intent: "worker.dispatch",
      goal: "prove process restart recovery",
      sessionId: session.id,
      workSessionId: session.id,
      workerRunId: "run-terminal-c1",
      executorKind: "internal_chat_agent",
      acceptanceCriteria: ["restart records an interrupted terminal attempt"],
    },
    "trace-terminal-c1",
  );
  await WorkItemStore.start(item.workItemId, "trace-terminal-c1");
  const allocation = await WorkItemStore.allocateAttempt(
    item.workItemId,
    attemptIdentity("terminal C1 restart"),
    "trace-terminal-c1",
  );
  assert(allocation, "attempt allocation failed");
  EffectStore.intend({ effectId: "effect-terminal-c1", kind: "crash-after-intent" });
  const receipt = {
    phase: "seed-restart",
    pid: process.pid,
    workItemHash: item.workItemId,
    sessionId: session.id,
    runStatus: WorkItemAttemptRun.find(session.id, "run-terminal-c1")?.status,
    effectStatus: EffectStore.status("effect-terminal-c1").status,
  };
  closeStorage();
  return receipt;
}

async function recoverRestart(dbPath: string): Promise<ChildReceipt> {
  Storage.initialize({ dbPath });
  const recovery = await recoverInterruptedRuns("trace-terminal-c1-restart");
  const reconciliation = await assembleEffectRuntime().reconciler.reconcile(
    "trace-terminal-c1-reconcile",
  );
  const item = WorkItemStore.list().find(
    (candidate) => candidate.workerRunId === "run-terminal-c1",
  );
  assert(item?.workSessionId, "seeded attempt missing after restart");
  const run = WorkItemAttemptRun.find(item.workSessionId, "run-terminal-c1");
  const effect = EffectStore.status("effect-terminal-c1");
  assert(run?.status === "interrupted", "restart did not terminalize active attempt");
  assert(effect.status === "confirmed", "restart did not reconcile pending effect");
  const receipt = {
    phase: "recover-restart",
    pid: process.pid,
    recovery,
    reconciliation,
    runStatus: run.status,
    runError: run.error,
    effectStatus: effect.status,
    effectMaterializations: effect.materializationCount,
  };
  closeStorage();
  return receipt;
}

async function proveRefute(): Promise<ChildReceipt> {
  const fact = VerifierRegistry.create().verify({
    obligationId: "terminal-c1-refute",
    kind: "archived_quote_match",
    claim: "The archived source says the release passed.",
    recordedInputs: {
      archivedText: "The archived source says the release failed.",
      quotedText: "the release passed",
    },
  });
  assert(fact.type === "verification_result" && fact.status === "refuted", "refute failed");
  return { phase: "refute", pid: process.pid, fact, ambientCapabilities: 0, liveEffects: 0 };
}

async function proveArchiveReadOnly(dbPath: string): Promise<ChildReceipt> {
  Storage.initialize({ dbPath });
  const session = Session.create({
    traceId: "trace-terminal-c1-archive",
    title: "frozen archive",
    model: { providerID: "terminal-c1", modelID: "no-network" },
  });
  closeStorage();
  const db = new Database(dbPath);
  db.query(
    `INSERT INTO worker_run_state
      (run_id, session_id, parent_session_id, agent_name, status, title, prompt,
       resume_count, assigned_step_id, error, time_created, time_updated, executor_kind)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)`,
  ).run(
    "archived-run-terminal-c1",
    session.id,
    "archive-agent",
    "completed",
    "archived title",
    "archived prompt",
    1,
    2,
    "internal_chat_agent",
  );
  const before = Number(
    (db.query("SELECT total_changes() AS count").get() as { count: number }).count,
  );
  db.close();

  Storage.initialize({ dbPath });
  const history = await BusQuery.getWorkerRunHistory(session.id);
  closeStorage();
  const inspect = new Database(dbPath, { readonly: true });
  const count = Number(
    (inspect.query("SELECT COUNT(*) AS count FROM worker_run_state").get() as { count: number })
      .count,
  );
  inspect.close();
  assert(history.length === 1 && count === 1, "archive read changed or lost the frozen row");
  return { phase: "archive-read-only", pid: process.pid, before, rowCountAfter: count, history };
}

async function proveCasAndTail(dbPath: string): Promise<ChildReceipt> {
  Storage.initialize({ dbPath });
  const ledger = Storage.getAdapter().ledger;
  assert(ledger, "production ledger capability missing");
  const first = ledger.append(
    { streamId: "terminal-c1-cas", type: "terminal.seeded", data: { value: 1 } },
    0,
  );
  const stale = ledger.append(
    { streamId: "terminal-c1-cas", type: "terminal.stale", data: { value: 2 } },
    0,
  );
  const intact = ledger.verifyTail();
  assert(first.kind === "appended" && stale.kind === "cas_conflict", "CAS proof failed");
  assert(intact.length === 0, "intact tail did not verify");
  closeStorage();

  const db = new Database(dbPath);
  db.query("UPDATE ledger_event SET data = ? WHERE stream_id = ? AND seq = 1").run(
    '{"value":999}',
    "terminal-c1-cas",
  );
  db.close();
  Storage.initialize({ dbPath });
  const breaks = Storage.getAdapter().ledger?.verifyTail() ?? [];
  closeStorage();
  assert(
    breaks.some((entry) => entry.streamId === "terminal-c1-cas"),
    "tail tamper escaped",
  );
  return {
    phase: "cas-tail",
    pid: process.pid,
    first,
    stale,
    intactBreaks: intact,
    tamperedBreaks: breaks,
  };
}

async function spawnJson(
  command: string[],
  env: Record<string, string> = {},
): Promise<SpawnReceipt> {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const pid = child.pid;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert(exitCode === 0, `child ${pid} failed (${exitCode}): ${stderr || stdout}`);
  const receipt = JSON.parse(stdout) as ChildReceipt;
  return { pid, command, receipt };
}

export async function runTerminalC1(): Promise<Record<string, unknown>> {
  const tempDir = mkdtempSync(join(tmpdir(), "openomni-terminal-c1-"));
  const dbPath = join(tempDir, "terminal-c1.db");
  try {
    const manualAuthenticated = await spawnJson([
      "bun",
      DRIVER,
      "--scenario",
      "authenticated-request",
      "--json",
    ]);
    const manualDenied = await spawnJson([
      "bun",
      DRIVER,
      "--scenario",
      "invalid-generation-token",
      "--json",
    ]);
    const child = (phase: string) =>
      spawnJson(["bun", import.meta.path, "--child", phase, "--db", dbPath]);
    const seeded = await child("seed-restart");
    assert(existsSync(dbPath), "restart seed process did not create SQLite state");
    const recovered = await child("recover-restart");
    const [refuted, archived, casTail] = await Promise.all([
      child("refute"),
      child("archive-read-only"),
      spawnJson(["bun", import.meta.path, "--child", "cas-tail", "--db", join(tempDir, "cas.db")]),
    ]);
    return {
      proof: "terminal-separate-process-c1",
      orchestratorPid: process.pid,
      noLiveReplayEffects: true,
      manualAuthenticated,
      manualDenied,
      restart: { seeded, recovered, distinctPids: seeded.pid !== recovered.pid },
      refuted,
      archived,
      casTail,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function childMain(phase: string, dbPath: string): Promise<ChildReceipt> {
  if (phase === "seed-restart") return seedRestart(dbPath);
  if (phase === "recover-restart") return recoverRestart(dbPath);
  if (phase === "refute") return proveRefute();
  if (phase === "archive-read-only") return proveArchiveReadOnly(dbPath);
  if (phase === "cas-tail") return proveCasAndTail(dbPath);
  throw new Error(`unknown child phase: ${phase}`);
}

if (import.meta.main) {
  const childIndex = process.argv.indexOf("--child");
  const dbIndex = process.argv.indexOf("--db");
  const receipt =
    childIndex >= 0
      ? await childMain(process.argv[childIndex + 1] ?? "", process.argv[dbIndex + 1] ?? "")
      : await runTerminalC1();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
