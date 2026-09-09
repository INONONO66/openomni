import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bounded } from "./helpers/bounded";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  Alarm,
  type BusEvent,
  canonicalDigest,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  L0Observation,
  type ObservationSink,
  type PlainValue,
  type PolicyRow,
  type SessionTransition,
  type SessionTurn,
} from "@openomni/protocol";
import { createExecutor, SEEDED_POLICY_ROWS } from "../src/index";
import type {
  ExecutionApprovalRequest,
  ExecutionApprovals,
  ExecutionBatchResult,
} from "../src/executor";
import {
  closeSessions,
  session,
  type SessionRunner,
  type SessionRunnerInput,
  type SessionRunnerResult,
  type SessionRuntime,
  sweepSessions,
  wakeSession,
} from "../src/session-handle";
import { createSessionRequests } from "../src/session-requests";
import { commitSessionRequest } from "../src/session-admission";
import { z } from "zod";

// ---------------------------------------------------------------------------
// HARNESS (docs/session-lifecycle-contract.md section 6): real ledger, session
// controller, executor waves, request transitions, outbound obligations and
// alarm rows. Every step snapshots the complete durable product of each
// traced session, checks the standing invariants, and the finished trace is
// replayed from the file-backed SQLite image with zero dispatch.
// ---------------------------------------------------------------------------

const SIGNAL_TIMEOUT_MS = 2_000;

interface Signal<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function signal<T>(): Signal<T> {
  const resolvers = Promise.withResolvers<T>();
  return { promise: resolvers.promise, resolve: resolvers.resolve, reject: resolvers.reject };
}

const ToolEventCall = z.object({ toolCallId: z.string() }).loose();

/** The storage/runtime observation sink: a lossy post-commit tape, never truth. */
class TraceSink implements ObservationSink {
  readonly committedEvents: L0Observation.ActionCommitted[] = [];
  readonly started: string[] = [];
  readonly completed: string[] = [];
  readonly waiters: ((committed: L0Observation.ActionCommitted) => void)[] = [];

  publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    if (event.name === L0Observation.ActionCommittedEvent.name) {
      const committed = L0Observation.ActionCommitted.parse(data);
      this.committedEvents.push(committed);
      for (const waiter of this.waiters.splice(0)) waiter(committed);
      return;
    }
    const call = ToolEventCall.safeParse(data);
    if (!call.success) return;
    if (event.name === "tool.execution.started") this.started.push(call.data.toolCallId);
    if (event.name === "tool.execution.completed") this.completed.push(call.data.toolCallId);
  }

  resetToolTape(): void {
    this.started.length = 0;
    this.completed.length = 0;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  /** Register before triggering: resolves on the first committed action satisfying `match`. */
  committed(match: (committed: L0Observation.ActionCommitted) => boolean): Promise<void> {
    const ready = signal<void>();
    const waiter = (committed: L0Observation.ActionCommitted) => {
      if (match(committed)) ready.resolve();
      else this.waiters.push(waiter);
    };
    this.waiters.push(waiter);
    return ready.promise;
  }
}

interface SessionSnapshot {
  readonly row: LedgerSession.Row;
  readonly actions: readonly LedgerAction.Node[];
  readonly inbox: readonly Inbox.Row[];
  readonly requests: readonly SessionTransition.Request[];
  readonly outbound: readonly SessionTransition.Outbound[];
  readonly tail: SessionTurn.Snapshot;
}

function snapshotOf(sessionId: string): SessionSnapshot | undefined {
  if (!SessionHandleStore.listRows().some((row) => row.id === sessionId)) return undefined;
  return {
    row: SessionHandleStore.row(sessionId),
    actions: SessionHandleStore.tree(sessionId),
    inbox: SessionHandleStore.inboxRows(sessionId),
    requests: SessionHandleStore.requestRows(sessionId),
    outbound: SessionHandleStore.outboundRows(sessionId),
    tail: SessionHandleStore.getSnapshot(sessionId, 4),
  };
}

function objectValue(
  value: LedgerAction.Node["intent"]["value"],
): Record<string, LedgerAction.Node["intent"]["value"]> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function phaseOf(action: LedgerAction.Node): string | undefined {
  const phase = objectValue(action.effect.value)?.phase;
  return typeof phase === "string" ? phase : undefined;
}

function assertAppendOnly(before: SessionSnapshot | undefined, after: SessionSnapshot): void {
  if (before === undefined) return;
  expect(after.actions.slice(0, before.actions.length)).toEqual([...before.actions]);
  expect(after.inbox.length).toBeGreaterThanOrEqual(before.inbox.length);
}

function assertCausalLinks(after: SessionSnapshot): void {
  const seen = new Set<string>();
  for (const action of after.actions) {
    expect(action.sessionId).toBe(after.row.id);
    if (action.parentId !== null) expect(seen.has(action.parentId)).toBe(true);
    expect(seen.has(action.id)).toBe(false);
    seen.add(action.id);
  }
  expect(after.row.revision).toBe(after.actions.length);
}

function assertTerminalUniqueness(after: SessionSnapshot): void {
  const turnTerminals = new Map<string, number>();
  const toolResults = new Map<string, number>();
  for (const action of after.actions) {
    const terminal = SessionHandleStore.turnTerminal(action);
    if (terminal !== undefined)
      turnTerminals.set(terminal.turnId, (turnTerminals.get(terminal.turnId) ?? 0) + 1);
    if (action.kind === "tool" && phaseOf(action) === "result" && action.parentId !== null)
      toolResults.set(action.parentId, (toolResults.get(action.parentId) ?? 0) + 1);
  }
  for (const count of [...turnTerminals.values(), ...toolResults.values()]) expect(count).toBe(1);
  for (const turn of SessionHandleStore.openTurns(after.actions))
    expect(turnTerminals.has(turn.turnId)).toBe(false);
}

function assertInputConsumption(after: SessionSnapshot): void {
  const deliveries = new Map<string, number>();
  for (const action of after.actions) {
    const delivery = SessionHandleStore.delivery(action);
    if (delivery !== undefined)
      deliveries.set(delivery.inboxId, (deliveries.get(delivery.inboxId) ?? 0) + 1);
  }
  for (const row of after.inbox) {
    expect(after.actions.some((action) => action.id === row.id)).toBe(true);
    expect(deliveries.get(row.id) ?? 0).toBeLessThanOrEqual(1);
    if (row.status === "pending") {
      expect(row.consumedBy).toBeNull();
      expect(deliveries.has(row.id)).toBe(false);
    } else expect(row.consumedBy).not.toBeNull();
  }
}

function assertObservations(
  before: SessionSnapshot | undefined,
  after: SessionSnapshot,
  events: readonly L0Observation.ActionCommitted[],
): void {
  const appended = after.actions.slice(before?.actions.length ?? 0);
  // Storage and executor may both notify one commit; two notifications are not two actions.
  const observed = events.filter(
    (committed, index) =>
      committed.sessionId === after.row.id &&
      events.findIndex((other) => other.id === committed.id) === index,
  );
  expect(observed.map((committed) => [committed.id, committed.kind])).toEqual(
    appended.map((action) => [action.id, action.kind]),
  );
  for (const committed of observed) {
    expect(committed.revision).toBeGreaterThan(before?.row.revision ?? 0);
    expect(committed.revision).toBeLessThanOrEqual(after.row.revision);
  }
}

interface TraceStep {
  readonly name: string;
  run(): Promise<void> | void;
}

interface Trace {
  readonly sessions: readonly string[];
  readonly steps: readonly TraceStep[];
  /** Count of physical bodies/dispatches executed so far; replay must not move it. */
  readonly dispatched: () => number;
}

interface TraceResult {
  readonly named: ReadonlyMap<string, ReadonlyMap<string, SessionSnapshot>>;
  readonly final: ReadonlyMap<string, SessionSnapshot>;
}

let sink: TraceSink;
let dbPath: string;
let directory: string;
let now = 1_000;
let nextId = 0;
const runtimes: SessionRuntime[] = [];

function seedPolicy(rows: readonly Omit<PolicyRow.Row, "generation">[] = []): void {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("missing policy adapter");
  for (const row of [...SEEDED_POLICY_ROWS, ...rows]) policies.append({ ...row, generation: 1 });
}

beforeEach(() => {
  now = 1_000;
  nextId = 0;
  sink = new TraceSink();
  directory = mkdtempSync(join(tmpdir(), "lifecycle-conformance-"));
  dbPath = join(directory, "ledger.sqlite");
  Storage.initialize({ dbPath, observationSink: sink });
  seedPolicy();
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await closeSessions(runtime);
  Storage.reset();
  rmSync(directory, { recursive: true, force: true });
});

function runtimeFor(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  const runtime: SessionRuntime = {
    observations: sink,
    clock: () => now,
    entropy: () => `id-${++nextId}`,
    processId: "conformance",
    scheduleHeartbeat: () => () => undefined,
    authorizeApproval: async () => ({
      kind: "owner",
      principalId: "owner",
      evidenceId: "credential",
    }),
    ...overrides,
  };
  runtimes.push(runtime);
  return runtime;
}

/** Section 6 harness entry: runs the vector, checks every prefix, then proves effect-free replay. */
export async function runLifecycleTrace(trace: Trace): Promise<TraceResult> {
  const named = new Map<string, ReadonlyMap<string, SessionSnapshot>>();
  const previous = new Map<string, SessionSnapshot>();
  for (const sessionId of trace.sessions) {
    const seed = snapshotOf(sessionId);
    if (seed === undefined) continue;
    assertCausalLinks(seed);
    previous.set(sessionId, seed);
  }
  for (const step of trace.steps) {
    const mark = sink.committedEvents.length;
    await step.run();
    const events = sink.committedEvents.slice(mark);
    const current = new Map<string, SessionSnapshot>();
    for (const sessionId of trace.sessions) {
      const after = snapshotOf(sessionId);
      if (after === undefined) continue;
      const before = previous.get(sessionId);
      assertAppendOnly(before, after);
      assertCausalLinks(after);
      assertTerminalUniqueness(after);
      assertInputConsumption(after);
      assertObservations(before, after, events);
      current.set(sessionId, after);
      previous.set(sessionId, after);
    }
    named.set(step.name, current);
  }
  await replayEffectFree(previous, trace.dispatched);
  return { named, final: previous };
}

/** Reopen the committed image: the fold equals the last prefix, dispatch and observations stay empty. */
async function replayEffectFree(
  expected: ReadonlyMap<string, SessionSnapshot>,
  dispatched: () => number,
): Promise<void> {
  for (const runtime of runtimes.splice(0)) await closeSessions(runtime);
  const bodies = dispatched();
  const mark = sink.committedEvents.length;
  sink.resetToolTape();
  Storage.reset();
  Storage.initialize({ dbPath, observationSink: sink });
  for (const [sessionId, snapshot] of expected) {
    const replayed = snapshotOf(sessionId);
    if (replayed === undefined) throw new Error(`replay lost session ${sessionId}`);
    expect(replayed.actions).toEqual(snapshot.actions);
    expect(replayed.inbox).toEqual(snapshot.inbox);
    expect(replayed.requests).toEqual(snapshot.requests);
    expect(replayed.outbound).toEqual(snapshot.outbound);
    expect(replayed.tail.turns).toEqual(snapshot.tail.turns);
    expect({ ...replayed.row, leaseOwner: null, leaseExpiresAt: null }).toEqual({
      ...snapshot.row,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }
  expect(sink.committedEvents.slice(mark)).toEqual([]);
  expect([sink.started, sink.completed]).toEqual([[], []]);
  expect(dispatched()).toBe(bodies);
}

function kinds(snapshot: SessionSnapshot | undefined): string[] {
  return (snapshot?.actions ?? []).map((action) => action.kind);
}

/** `[kind, resolution]` of every action after the four-action request seed. */
function resolutions(snapshot: SessionSnapshot | undefined): [string, PlainValue | undefined][] {
  return (snapshot?.actions ?? [])
    .slice(4)
    .map((action) => [action.kind, objectValue(action.effect.value)?.resolution]);
}

function hookOf(sessionId: string, actionId: string): string | undefined {
  const action = SessionHandleStore.tree(sessionId).find((node) => node.id === actionId);
  const hook = action === undefined ? undefined : objectValue(action.intent.value)?.hook;
  return typeof hook === "string" ? hook : undefined;
}

// ---------------------------------------------------------------------------
// Whole-wave fixture (section 6.3): four parsed requests A,B,C,D through the
// real `createExecutor.runBatch`, run inside the durable session runner. B
// requires Owner approval; D is the sequential batch item.
// ---------------------------------------------------------------------------

const WAVE = ["A", "B", "C", "D"] as const;
type WaveCall = (typeof WAVE)[number];

const approvalRule: Omit<PolicyRow.Row, "generation"> = {
  name: "B",
  kind: "tool",
  phase: "pre",
  match: { encodingVersion: 1, value: { op: "B" } },
  verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
  priority: 1,
};

interface WaveFixture {
  readonly handle: ReturnType<typeof session>;
  readonly runtime: SessionRuntime;
  readonly tape: WaveCall[];
  readonly entered: Record<WaveCall, Signal<void>>;
  readonly gates: Record<WaveCall, Signal<void>>;
  readonly results: Signal<readonly ExecutionBatchResult[]>;
  readonly approvals: Signal<ExecutionApprovals>;
  dispatched(): number;
}

function waveSession(id: string, overrides: Partial<SessionRuntime> = {}): WaveFixture {
  const tape: WaveCall[] = [];
  const entered = { A: signal<void>(), B: signal<void>(), C: signal<void>(), D: signal<void>() };
  const gates = { A: signal<void>(), B: signal<void>(), C: signal<void>(), D: signal<void>() };
  const results = signal<readonly ExecutionBatchResult[]>();
  const approvals = signal<ExecutionApprovals>();
  const runtime = runtimeFor(overrides);
  const runner: SessionRunner = async (input) => {
    const executor = waveExecutor(input, runtime);
    if (executor.approvals === undefined) throw new Error("executor without approvals");
    input.bindApprovals?.(executor.approvals);
    approvals.resolve(executor.approvals);
    // A real tool wave registers with the turn so an interrupt seals only
    // after the wave's cancelled results are committed (session-turn `waves`).
    const wave = executor.runBatch(
      WAVE.map((call) => ({
        request: {
          kind: "tool",
          op: call,
          intent: { value: call },
          effect: { category: "query" },
          toolObservation: { turnId: input.turnId, callId: call },
        },
        ...(call === "D" ? { sequential: true as const } : {}),
        async body() {
          entered[call].resolve();
          await gates[call].promise;
          tape.push(call);
          return { status: "success", output: call };
        },
      })),
      { signal: input.signal },
    );
    input.trackWave?.(
      wave.then(
        () => undefined,
        () => undefined,
      ),
    );
    const outcome = await wave.catch((error: Error) => {
      results.reject(error);
      throw error;
    });
    results.resolve(outcome);
    if (input.signal.aborted) return { kind: "interrupted" };
    return { kind: "result", text: outcome.map((slot) => slot.terminal).join(",") };
  };
  const handle = session({ id, role: "resident", runner }, runtime);
  return {
    handle,
    runtime,
    tape,
    entered,
    gates,
    results,
    approvals,
    dispatched: () => tape.length,
  };
}

function waveExecutor(input: SessionRunnerInput, runtime: SessionRuntime) {
  return createExecutor({
    signal: input.signal,
    policy: input.policy,
    ledger: input.ledger,
    observations: runtime.observations,
    clock: runtime.clock ?? Date.now,
    entropy: runtime.entropy ?? (() => crypto.randomUUID()),
    authorizeApproval: runtime.authorizeApproval,
    approvalTimeoutMs: runtime.approvalTimeoutMs,
    retainEffect: input.retainEffect,
    identity: {
      sessionId: input.sessionId,
      role: input.role,
      parentActionId: input.turnId,
      turnId: input.turnId,
      toolsGeneration: input.toolsGeneration,
      toolsHash: input.toolsHash,
      systemHash: input.systemHash,
    },
  });
}

async function openWaveAtApproval(fixture: WaveFixture, text: string) {
  sink.resetToolTape();
  const requested = sink.committed(
    (committed) => committed.sessionId === fixture.handle.id && committed.kind === "request",
  );
  const running = fixture.handle.prompt(text);
  await bounded(requested, "approval request commit", SIGNAL_TIMEOUT_MS);
  const approvals = await bounded(fixture.approvals.promise, "bound approvals", SIGNAL_TIMEOUT_MS);
  const pending = approvals.pending()[0];
  if (pending === undefined) throw new Error("missing pending approval");
  expect(fixture.tape).toEqual([]);
  expect(sink.started).toEqual([]);
  return { running, approvals, pending };
}

async function releaseBodies(fixture: WaveFixture, order: readonly WaveCall[]): Promise<void> {
  const parallel = order.filter((call) => call !== "D");
  await bounded(
    Promise.all(parallel.map((call) => fixture.entered[call].promise)),
    "parallel body entry",
    SIGNAL_TIMEOUT_MS,
  );
  expect(sink.started).toEqual([...parallel].sort());
  expect(sink.completed).toEqual([]);
  for (const call of parallel) fixture.gates[call].resolve();
  await bounded(
    fixture.entered.D.promise,
    "sequential body entry after the parallel barrier",
    SIGNAL_TIMEOUT_MS,
  );
  expect(fixture.tape).toEqual([...parallel]);
  expect(
    SessionHandleStore.tree(fixture.handle.id).some(
      (action) => action.kind === "tool" && phaseOf(action) === "result",
    ),
  ).toBe(false);
  fixture.gates.D.resolve();
}

/** `kind:phase` per committed action: the shape of a named snapshot's history. */
function shape(snapshot: SessionSnapshot | undefined): string[] {
  return (snapshot?.actions ?? []).map((action) => `${action.kind}:${phaseOf(action) ?? "-"}`);
}

/** cfg, P, prompt.pre/post, delivery, T, turn.pre: the seven-action session wrapper of 6.3. */
const TURN_PREFIX = [
  "session.configure:configured",
  "prompt:-",
  "policy.decision:result",
  "policy.decision:result",
  "inbox.deliver:delivery",
  "turn:pending",
  "policy.decision:result",
];
const TURN_SUFFIX = ["policy.decision:result", "turn:terminal"];
const WAVE_PRE = WAVE.map(() => "policy.decision:result");
const WAVE_INTENT = WAVE.map(() => "tool:pending");

// ---------------------------------------------------------------------------
// 6.7 named registrations
// ---------------------------------------------------------------------------

describe("session lifecycle conformance", () => {
  test("lifecycle v1 ordinary and mixed-wave approved", async () => {
    seedPolicy([approvalRule]);
    const ordinary = runtimeFor();
    const gate = signal<void>();
    const plain = session(
      {
        id: "S",
        role: "resident",
        runner: async () => {
          await gate.promise;
          return { kind: "result", text: "done" };
        },
      },
      ordinary,
    );
    const wave = waveSession("W");
    let plainRunning: Promise<SessionRunnerResult | undefined> | undefined;
    let wavePending: ExecutionApprovalRequest | undefined;
    let waveRunning: Promise<SessionRunnerResult | undefined> | undefined;
    let waveApprovals: ExecutionApprovals | undefined;

    const result = await runLifecycleTrace({
      sessions: ["S", "W"],
      dispatched: wave.dispatched,
      steps: [
        { name: "BASE", run: () => undefined },
        {
          name: "RUN",
          run: async () => {
            const entered = sink.committed(
              (committed) =>
                committed.sessionId === "S" && hookOf("S", committed.id) === "turn.pre",
            );
            plainRunning = plain.prompt("hello");
            await bounded(entered, "turn pre decision", SIGNAL_TIMEOUT_MS);
          },
        },
        {
          name: "DONE",
          run: async () => {
            const sealed = sink.committed(
              (committed) =>
                committed.sessionId === "S" &&
                SessionHandleStore.turnTerminal(
                  SessionHandleStore.tree("S").find((action) => action.id === committed.id),
                ) !== undefined,
            );
            gate.resolve();
            await bounded(sealed, "terminal result", SIGNAL_TIMEOUT_MS);
            expect(
              await bounded(
                plainRunning ?? Promise.reject(new Error("no run")),
                "result",
                SIGNAL_TIMEOUT_MS,
              ),
            ).toEqual({
              kind: "result",
              text: "done",
            });
          },
        },
        {
          name: "WAIT",
          run: async () => {
            const opened = await openWaveAtApproval(wave, "wave");
            wavePending = opened.pending;
            waveRunning = opened.running;
            waveApprovals = opened.approvals;
          },
        },
        {
          name: "APPROVED",
          run: async () => {
            if (wavePending === undefined || waveApprovals === undefined)
              throw new Error("no wait");
            await waveApprovals.answer({
              request: wavePending,
              credential: "owner-token",
              decision: "approve",
            });
          },
        },
        {
          name: "WAVE_APPROVED",
          run: async () => {
            await releaseBodies(wave, ["C", "A", "B", "D"]);
            expect(
              await bounded(
                waveRunning ?? Promise.reject(new Error("no run")),
                "wave",
                SIGNAL_TIMEOUT_MS,
              ),
            ).toEqual({
              kind: "result",
              text: "executed,executed,executed,executed",
            });
            expect(sink.completed).toEqual(["A", "B", "C", "D"]);
          },
        },
      ],
    });

    const done = result.named.get("DONE")?.get("S");
    expect(kinds(done)).toEqual([
      "session.configure",
      "prompt",
      "policy.decision",
      "policy.decision",
      "inbox.deliver",
      "turn",
      "policy.decision",
      "policy.decision",
      "turn",
    ]);
    expect(done?.row).toMatchObject({
      revision: 9,
      state: "idle",
      leaseOwner: null,
      leaseFence: 1,
    });
    expect(done?.inbox.map((row) => row.status)).toEqual(["consumed"]);
    expect(done?.tail.turns.at(-1)).toMatchObject({
      state: "idle",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "done" },
      ],
    });

    const wait = result.named.get("WAIT")?.get("W");
    expect(shape(wait)).toEqual([...TURN_PREFIX, ...WAVE_PRE, ...WAVE_INTENT, "request:state"]);
    expect(wait?.requests.map((request) => request.state)).toEqual(["open"]);
    const approved = result.named.get("WAVE_APPROVED")?.get("W");
    expect(shape(approved)).toEqual([
      ...TURN_PREFIX,
      ...WAVE_PRE,
      ...WAVE_INTENT,
      "request:state",
      "reply:state",
      "request:state",
      ...WAVE.map(() => "tool:application"),
      ...WAVE.flatMap(() => ["policy.decision:result", "tool:result"]),
      ...TURN_SUFFIX,
    ]);
    expect(approved?.row.revision).toBe(32);
    expect(approved?.requests.map((request) => [request.state, request.outcome])).toEqual([
      ["resolved", "answered"],
    ]);
    const results = await bounded(wave.results.promise, "wave results", SIGNAL_TIMEOUT_MS);
    expect(results).toEqual(
      WAVE.map((call) => ({ terminal: "executed", value: { status: "success", output: call } })),
    );
    expect(wave.tape).toEqual(["C", "A", "B", "D"]);
    const resultsInOrder = (approved?.actions ?? [])
      .filter((action) => action.kind === "tool" && phaseOf(action) === "result")
      .map((action) => objectValue(action.effect.value)?.callId);
    expect(resultsInOrder).toEqual(["A", "B", "C", "D"]);
  });

  test("lifecycle v1 refusal timeout and interrupt", async () => {
    seedPolicy([approvalRule]);
    const refused = waveSession("REFUSED");
    const timed = waveSession("TIMED", { approvalTimeoutMs: 100 });
    const interrupted = waveSession("INTERRUPTED");
    const timedPort = createSessionRequests(timed.runtime);
    const runs = new Map<string, Promise<SessionRunnerResult | undefined>>();

    const result = await runLifecycleTrace({
      sessions: ["REFUSED", "TIMED", "INTERRUPTED"],
      dispatched: () => refused.dispatched() + timed.dispatched() + interrupted.dispatched(),
      steps: [
        {
          name: "REFUSE",
          run: async () => {
            const opened = await openWaveAtApproval(refused, "refuse");
            runs.set("REFUSED", opened.running);
            await opened.approvals.answer({
              request: opened.pending,
              credential: "owner-token",
              decision: "refuse",
            });
            await expect(
              opened.approvals.answer({
                request: opened.pending,
                credential: "owner-token",
                decision: "approve",
              }),
            ).rejects.toMatchObject({ code: "stale_approval" });
          },
        },
        {
          name: "WAVE_REFUSED",
          run: async () => {
            await releaseBodies(refused, ["C", "A", "D"]);
            await bounded(
              runs.get("REFUSED") ?? Promise.reject(new Error("no run")),
              "refused",
              SIGNAL_TIMEOUT_MS,
            );
          },
        },
        {
          name: "TIMED",
          run: async () => {
            const opened = await openWaveAtApproval(timed, "timeout");
            runs.set("TIMED", opened.running);
            now = 1_100;
            // The durable deadline fires once; the delayed duplicate timer and
            // the late approve both lose to the committed expiry.
            timedPort.timeout(opened.pending.id, now);
            timedPort.timeout(opened.pending.id, now);
            await expect(
              opened.approvals.answer({
                request: opened.pending,
                credential: "owner-token",
                decision: "approve",
              }),
            ).rejects.toMatchObject({ code: "stale_approval" });
          },
        },
        {
          name: "WAVE_TIMEOUT",
          run: async () => {
            await releaseBodies(timed, ["C", "A", "D"]);
            await bounded(
              runs.get("TIMED") ?? Promise.reject(new Error("no run")),
              "timed",
              SIGNAL_TIMEOUT_MS,
            );
          },
        },
        {
          name: "WAVE_INTERRUPTED",
          run: async () => {
            now = 1_000;
            const opened = await openWaveAtApproval(interrupted, "interrupt");
            const aborted = interrupted.results.promise;
            await interrupted.handle.interrupt();
            expect(await bounded(aborted, "cancelled wave", SIGNAL_TIMEOUT_MS)).toEqual(
              WAVE.map(() => ({ terminal: "cancelled" })),
            );
            await bounded(opened.running, "interrupted turn", SIGNAL_TIMEOUT_MS);
          },
        },
      ],
    });

    // Bodies settle before the first post action; results then commit in slot
    // order A, B(blocked, no post), C, D. Refusal records the owner reply;
    // expiry records the single deadline input. Both then resolve once.
    const blockedTail = [
      "tool:application",
      "tool:application",
      "tool:application",
      "policy.decision:result",
      "tool:result",
      "tool:result",
      "policy.decision:result",
      "tool:result",
      "policy.decision:result",
      "tool:result",
      ...TURN_SUFFIX,
    ];
    for (const [id, reason, state, input] of [
      ["REFUSED", "approval_refused", "refused", "reply:state"],
      ["TIMED", "approval_timeout", "expired", "request:state"],
    ] as const) {
      const final = result.final.get(id);
      expect(shape(final)).toEqual([
        ...TURN_PREFIX,
        ...WAVE_PRE,
        ...WAVE_INTENT,
        "request:state",
        input,
        "request:state",
        ...blockedTail,
      ]);
      expect(final?.row).toMatchObject({ revision: 30, state: "idle", leaseOwner: null });
      const blocked = final?.actions.find(
        (action) =>
          action.kind === "tool" && objectValue(action.effect.value)?.terminal === "blocked_pre",
      );
      expect(blocked === undefined ? undefined : objectValue(blocked.effect.value)).toMatchObject({
        callId: "B",
        reason,
      });
      expect(final?.requests.map((request) => [request.state, request.outcome])).toEqual([
        [state, id === "REFUSED" ? "denied" : "outcome_unknown"],
      ]);
    }
    expect(
      await bounded(refused.results.promise, "refused results", SIGNAL_TIMEOUT_MS),
    ).toMatchObject([
      { terminal: "executed" },
      { terminal: "blocked_pre", reason: "approval_refused" },
      { terminal: "executed" },
      { terminal: "executed" },
    ]);
    expect(refused.tape).toEqual(["C", "A", "D"]);
    expect(timed.tape).toEqual(["C", "A", "D"]);
    expect(interrupted.tape).toEqual([]);
    expect([sink.started, sink.completed]).toEqual([[], []]);
    // Interrupt at the gate: the interrupt input commits, the open request is
    // cancelled by the session principal and resolved, every slot is cancelled
    // without a body or post decision, then the turn seals as interrupted.
    const cancelled = result.final.get("INTERRUPTED");
    expect(shape(cancelled)).toEqual([
      ...TURN_PREFIX,
      ...WAVE_PRE,
      ...WAVE_INTENT,
      "request:state",
      "prompt:-",
      "request:state",
      "request:state",
      ...WAVE.map(() => "tool:result"),
      "policy.decision:result",
      "inbox.deliver:delivery",
      "turn:terminal",
    ]);
    expect(cancelled?.row).toMatchObject({ revision: 26, state: "interrupted" });
    expect(cancelled?.requests.map((request) => [request.state, request.outcome])).toEqual([
      ["cancelled", "cancelled"],
    ]);
    expect(
      cancelled?.actions.flatMap((action) =>
        action.kind === "tool" && phaseOf(action) === "result"
          ? [objectValue(action.effect.value)?.terminal]
          : [],
      ),
    ).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(cancelled?.inbox.map((row) => [row.kind, row.status])).toEqual([
      ["prompt", "consumed"],
      ["interrupt", "consumed"],
    ]);
  });

  test("lifecycle v1 terminal resume differs from crash-open recovery", async () => {
    const runtime = runtimeFor();
    const entered = signal<SessionRunnerInput>();
    const aborted = signal<void>();
    const resumedEntry = signal<SessionRunnerInput>();
    let entries = 0;
    const runner: SessionRunner = async (input) => {
      entries += 1;
      if (entries === 1) {
        input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve(input);
        await aborted.promise;
        return { kind: "result", text: "late" };
      }
      resumedEntry.resolve(input);
      return { kind: "result", text: "resumed" };
    };
    const handle = session({ id: "S", role: "resident", runner }, runtime);
    let firstInput: SessionRunnerInput | undefined;
    let recovered: SessionRunnerInput | undefined;

    const result = await runLifecycleTrace({
      sessions: ["S", "C"],
      dispatched: () => entries,
      steps: [
        {
          name: "INTERRUPTED",
          run: async () => {
            const running = handle.prompt("hello");
            firstInput = await bounded(entered.promise, "runner entry", SIGNAL_TIMEOUT_MS);
            await handle.interrupt();
            await bounded(running, "interrupted seal", SIGNAL_TIMEOUT_MS);
            expect(handle.get().state).toBe("interrupted");
          },
        },
        {
          name: "RESUME_DONE",
          run: async () => {
            now = 1_050;
            await handle.system.blocks.set([{ id: "b", source: "fixture", content: "v2" }]);
            await handle.resume();
            recovered = await bounded(resumedEntry.promise, "resumed entry", SIGNAL_TIMEOUT_MS);
          },
        },
        {
          name: "CRASH_OPEN",
          run: () => {
            seedCrashOpen("C");
          },
        },
        {
          name: "CRASH_DONE",
          run: async () => {
            now = 2_000;
            const swept = signal<SessionRunnerInput>();
            await bounded(
              sweepSessions(
                () => async (input) => {
                  swept.resolve(input);
                  return { kind: "result", text: "recovered" };
                },
                runtime,
              ),
              "boot sweep",
              SIGNAL_TIMEOUT_MS,
            );
            const input = await bounded(swept.promise, "sweep entry", SIGNAL_TIMEOUT_MS);
            expect(input).toMatchObject({ resultId: "R", resumeCount: 1, toolsGeneration: 1 });
            expect(SessionHandleStore.row("C").toolsGeneration).toBe(2);
            const stale = SessionHandleStore.commit({
              sessionId: "C",
              owner: "dead",
              fence: 1,
              now,
              expectedRevision: SessionHandleStore.row("C").revision,
              actions: [],
              consumeInboxIds: [],
              state: "running",
              releaseLease: false,
            });
            expect(stale).toMatchObject({ ok: false, reason: "stale", currentFence: 2 });
          },
        },
      ],
    });

    const interrupted = result.named.get("INTERRUPTED")?.get("S");
    const terminal = interrupted?.actions.find(
      (a) => SessionHandleStore.turnTerminal(a) !== undefined,
    );
    expect(SessionHandleStore.turnTerminal(terminal)).toMatchObject({
      kind: "interrupted",
      resumeCount: 0,
    });
    expect(terminal?.id).toBe(firstInput?.resultId);
    expect(
      interrupted?.actions.some(
        (a) =>
          a.kind === "turn" &&
          phaseOf(a) === "terminal" &&
          objectValue(a.effect.value)?.text === "late",
      ),
    ).toBe(false);

    const resumed = result.named.get("RESUME_DONE")?.get("S");
    expect(recovered?.turnId).not.toBe(firstInput?.turnId);
    expect(recovered?.resultId).not.toBe(firstInput?.resultId);
    // Resume keeps the interrupted turn's history: the new turn sees "hello".
    expect(recovered).toMatchObject({ resumeCount: 1, toolsGeneration: 2 });
    expect(recovered?.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"],
    ]);
    expect(resumed?.row).toMatchObject({ state: "idle", toolsGeneration: 2, leaseFence: 3 });
    expect(resumed?.inbox.map((row) => [row.kind, row.status])).toEqual([
      ["prompt", "consumed"],
      ["interrupt", "consumed"],
      ["resume", "consumed"],
    ]);
    expect(resumed?.tail.turns.map((turn) => turn.terminal?.kind)).toEqual([
      "interrupted",
      "result",
    ]);

    const crash = result.named.get("CRASH_DONE")?.get("C");
    expect(crash?.row).toMatchObject({
      state: "idle",
      revision: 7,
      leaseFence: 2,
      toolsGeneration: 2,
    });
    expect(kinds(crash)).toEqual([
      "session.configure",
      "turn",
      "session.configure",
      "turn",
      "policy.decision",
      "policy.decision",
      "turn",
    ]);
    const crashTerminal = crash?.actions.at(-1);
    expect(crashTerminal?.id).toBe("R");
    expect(SessionHandleStore.turnTerminal(crashTerminal)).toMatchObject({
      turnId: "T",
      kind: "result",
      text: "recovered",
      resumeCount: 1,
    });
    expect(SessionHandleStore.turnResume(crash?.actions[3])).toMatchObject({
      turnId: "T",
      resultId: "R",
    });
  });

  test("lifecycle v1 delayed timer cancel reply and duplicate input", async () => {
    const runtime = runtimeFor();
    const port = createSessionRequests(runtime);
    const ids = ["QLATE", "QCANCEL", "QANSWER", "QREJECT"] as const;
    const opened = new Map<string, SessionTransition.Request>();
    const parentChild = childParentFixture();

    const result = await runLifecycleTrace({
      sessions: [...ids, "PARENT", "CHILD"],
      dispatched: () => parentChild.consumed(),
      steps: [
        // The loss-boundary sweep recovers every open turn in the store, so it
        // runs before the request fixtures open their own turns.
        { name: "CP_SEALED", run: () => parentChild.sealWithoutWake() },
        { name: "CP_RECEIVED", run: () => parentChild.recoverLosingAck() },
        { name: "CP_ACKED", run: () => parentChild.recoverAndAck() },
        {
          name: "QOPEN",
          run: () => {
            now = 1_000;
            for (const id of ids) {
              seedRequestSession(id);
              opened.set(id, openRequest(port, id));
            }
          },
        },
        {
          name: "QLATE",
          run: async () => {
            const q = requestOf(opened, "QLATE");
            expect(await port.answer(reply(q, "reply-1", 1_100))).toBe("late_unknown");
            expect(await port.answer(reply(q, "reply-1", 1_100))).toBe("late_unknown");
            port.timeout(q.requestId, 1_100);
            port.timeout(q.requestId, 1_100);
          },
        },
        {
          name: "QCANCEL_REPLY",
          run: async () => {
            const q = requestOf(opened, "QCANCEL");
            expect(cancelRequest(q, runtime)).toBe("cancelled");
            expect(await port.answer(reply(q, "reply-1", 1_099))).toBe("duplicate");
          },
        },
        {
          name: "QANSWER",
          run: async () => {
            const q = requestOf(opened, "QANSWER");
            expect(await port.answer(reply(q, "reply-1", 1_099))).toBe("resolved");
            expect(cancelRequest(q, runtime)).toBe("duplicate");
            expect(await port.answer(reply(q, "reply-1", 1_099))).toBe("resolved");
            expect(await port.answer({ ...reply(q, "reply-1", 1_099), content: "altered" })).toBe(
              "rejected",
            );
          },
        },
        {
          name: "QREJECT",
          run: async () => {
            const q = requestOf(opened, "QREJECT");
            expect(
              await port.answer({
                ...reply(q, "reject-who", 1_099),
                principal: { kind: "session", principalId: "stranger", evidenceId: "e" },
              }),
            ).toBe("rejected");
            expect(
              await port.answer({
                ...reply(q, "reject-input", 1_099),
                inputHash: canonicalDigest({ value: "altered" }),
              }),
            ).toBe("rejected");
            expect(
              await port.answer({
                ...reply(q, "reject-domain", 1_099),
                domainRevisions: { person: 5 },
              }),
            ).toBe("rejected");
          },
        },
      ],
    });

    assertRequestRaces(result);
    assertLossBoundary(result, parentChild);
  });

  test("lifecycle v1 alarm takeover pause rearm and dedupe", async () => {
    const alarms = Storage.get().alarms;
    if (alarms === undefined) throw new Error("missing alarm adapter");
    SessionHandleStore.materialize({
      id: "S",
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: "cfg",
      at: now,
    });
    const fire = (epoch: number, fence: number, sourceKey: string, content: string, at: number) =>
      alarms.fire({
        id: "A",
        epoch,
        fence,
        sourceKey,
        at,
        content,
        batchHash: content,
        terminal: false,
      });
    let evaluations = 0;
    const evaluate = (fired: Alarm.Fired | undefined) => {
      if (fired !== undefined) evaluations += 1;
      return fired;
    };

    const result = await runLifecycleTrace({
      sessions: ["S"],
      dispatched: () => evaluations,
      steps: [
        {
          name: "A_ARM",
          run: () => {
            expect(
              alarms.arm({
                id: "A",
                sessionId: "S",
                kind: "watch",
                fireAt: 1_000,
                spec: {
                  encodingVersion: 1,
                  value: {
                    watch: { command: "poll", description: "watch-1", persistent: true },
                    notificationLimit: 2,
                    policyGeneration: 1,
                  },
                },
              }),
            ).toMatchObject({ status: "armed", epoch: 1, fence: 0, notifications: 0 });
          },
        },
        {
          name: "A_LEASE",
          run: () => {
            expect(alarms.acquire("A", 0)).toMatchObject({ fence: 1 });
            expect(alarms.acquire("A", 0)).toBeUndefined();
          },
        },
        {
          name: "A_OPEN",
          run: () => {
            const first = evaluate(fire(1, 1, "poll-1", "A", 1_000));
            expect(first?.receipts.map((receipt) => receipt.action.id)).toEqual([
              Alarm.occurrenceId("A", 1, "poll-1"),
              first?.inbox.id ?? "",
            ]);
            expect(first?.row).toMatchObject({ notifications: 1, lastBatch: "A" });
          },
        },
        {
          name: "A_DEDUPED",
          run: () => {
            expect(evaluate(fire(1, 1, "poll-1", "A", 1_000))).toBeUndefined();
            expect(evaluate(fire(1, 1, "poll-2", "A", 1_060))).toBeUndefined();
            expect(evaluate(fire(1, 0, "poll-3", "B", 1_060))).toBeUndefined();
          },
        },
        {
          name: "A_B",
          run: () => {
            expect(evaluate(fire(1, 1, "poll-3", "B", 1_060))?.row).toMatchObject({
              notifications: 2,
              lastBatch: "B",
              status: "armed",
            });
          },
        },
        {
          name: "A_PAUSED",
          run: () => {
            const paused = evaluate(fire(1, 1, "poll-4", "C", 1_070));
            expect(paused?.row.status).toBe("paused");
            expect(paused?.receipts.map((receipt) => receipt.action.kind)).toEqual([
              "alarm.paused",
              "prompt",
            ]);
            expect(evaluate(fire(1, 1, "poll-5", "D", 1_070))).toBeUndefined();
            expect(alarms.due(2_000).map((row) => row.id)).toEqual([]);
          },
        },
        {
          name: "A_REARMED",
          run: () => {
            now = 1_080;
            const rearmed = alarms.rearm("A", "S", now);
            expect(rearmed).toMatchObject({
              status: "armed",
              epoch: 2,
              notifications: 0,
              lastBatch: null,
              fireAt: 1_080,
            });
            expect(alarms.rearm("A", "other", now)).toBeUndefined();
            expect(evaluate(fire(1, rearmed?.fence ?? -1, "poll-6", "A", 1_080))).toBeUndefined();
          },
        },
        {
          name: "A_TAKEN",
          run: () => {
            const fence = alarms.get("A")?.fence ?? -1;
            const taken = alarms.acquire("A", fence);
            expect(taken?.fence).toBe(fence + 1);
            expect(evaluate(fire(2, fence, "poll-7", "A", 1_080))).toBeUndefined();
            expect(evaluate(fire(2, fence + 1, "poll-7", "A", 1_080))?.row).toMatchObject({
              epoch: 2,
              notifications: 1,
            });
          },
        },
        {
          name: "ALARM_CANCELLED",
          run: () => {
            const fence = alarms.get("A")?.fence ?? -1;
            expect(alarms.cancel("A", "S", 1_090)?.status).toBe("cancelled");
            expect(evaluate(fire(2, fence, "poll-8", "B", 1_090))).toBeUndefined();
            expect(alarms.rearm("A", "S", 1_090)).toBeUndefined();
            expect(alarms.acquire("A", fence + 1)).toBeUndefined();
          },
        },
      ],
    });

    const final = result.final.get("S");
    expect(kinds(final)).toEqual([
      "session.configure",
      "alarm.arm",
      "alarm.fired",
      "prompt",
      "alarm.fired",
      "prompt",
      "alarm.paused",
      "prompt",
      "alarm.arm",
      "alarm.fired",
      "prompt",
      "alarm.arm",
    ]);
    expect(final?.inbox.map((row) => [row.kind, row.status, row.content])).toEqual([
      ["prompt", "pending", "A"],
      ["prompt", "pending", "B"],
      ["prompt", "pending", expect.stringContaining("wake_budget")],
      ["prompt", "pending", "A"],
    ]);
    expect(new Set(final?.inbox.map((row) => row.id)).size).toBe(4);
    expect(evaluations).toBe(4);
    // Read through the reopened image: the alarm row survives replay unchanged.
    expect(Storage.get().alarms?.get("A")).toMatchObject({ status: "cancelled", epoch: 2 });
  });

  test("lifecycle v1 product totality and effect-free prefix replay", async () => {
    const runtime = runtimeFor();
    const port = createSessionRequests(runtime);
    // Inbox ids are store-wide: a delivered reply keeps its input id, so each
    // session's contenders carry session-scoped input ids.
    const contenders = {
      answer: (q: SessionTransition.Request) =>
        port.answer(reply(q, `${q.sessionId}:reply-1`, 1_099)),
      refuse: (q: SessionTransition.Request) =>
        port.answer({ ...reply(q, `${q.sessionId}:refuse-1`, 1_099), decision: "refuse" }),
      cancel: (q: SessionTransition.Request) => Promise.resolve(cancelRequest(q, runtime)),
      timeout: (q: SessionTransition.Request) => {
        port.timeout(q.requestId, 1_100);
        return Promise.resolve(SessionHandleStore.requestById(q.requestId)?.state ?? "missing");
      },
    } as const;
    const names = Object.keys(contenders) as (keyof typeof contenders)[];
    const pairs = names.flatMap((first) =>
      names.filter((second) => second !== first).map((second) => [first, second] as const),
    );
    const opened = new Map<string, SessionTransition.Request>();
    const sessions = pairs.map(([first, second]) => `${first}-${second}`);

    const result = await runLifecycleTrace({
      sessions: [...sessions, "STALE"],
      dispatched: () => 0,
      steps: [
        {
          name: "QOPEN",
          run: () => {
            for (const id of [...sessions, "STALE"]) {
              seedRequestSession(id);
              opened.set(id, openRequest(port, id));
            }
          },
        },
        {
          name: "PRODUCT",
          run: async () => {
            for (const [first, second] of pairs) {
              const q = requestOf(opened, `${first}-${second}`);
              await contenders[first](q);
              const winner = SessionHandleStore.requestById(q.requestId);
              const before = SessionHandleStore.tree(q.sessionId).length;
              const loser = await contenders[second](q);
              expect(SessionHandleStore.requestById(q.requestId)).toMatchObject({
                state: winner?.state,
                outcome: winner?.outcome,
                replies: winner?.replies,
              });
              expect(SessionHandleStore.tree(q.sessionId).length).toBeLessThanOrEqual(before + 1);
              expect(["duplicate", "late_unknown", winner?.state]).toContain(loser);
            }
          },
        },
        {
          name: "CORRUPT",
          run: async () => {
            const q = requestOf(opened, "STALE");
            const fresh = SessionHandleStore.row(q.sessionId);
            await expect(
              Promise.resolve().then(() =>
                SessionHandleStore.commitRequestTransition({
                  sessionId: q.sessionId,
                  owner: "stranger",
                  fence: fresh.leaseFence,
                  now: 1_099,
                  expectedRevision: fresh.revision,
                  actions: [],
                  consumeInboxIds: [],
                  state: fresh.state,
                  releaseLease: false,
                }),
              ),
            ).resolves.toMatchObject({ ok: false, reason: "stale" });
            expect(
              await port.answer({ ...reply(q, "corrupt-binding", 1_099), bindingDigest: "forged" }),
            ).toBe("rejected");
            expect(
              await port.answer({ ...reply(q, "corrupt-generation", 1_099), generation: 9 }),
            ).toBe("rejected");
            expect(
              await port.answer({
                ...reply(q, "corrupt-effect", 1_099),
                effectHash: canonicalDigest({}),
              }),
            ).toBe("rejected");
            // Misrouted to a real session: refused there before any record, and
            // never applied here. The destination row does not move at all.
            const destination = SessionHandleStore.row("answer-refuse");
            const destinationTree = SessionHandleStore.tree("answer-refuse").length;
            expect(
              await port.answer({
                ...reply(q, "corrupt-session", 1_099),
                sessionId: "answer-refuse",
              }),
            ).toBe("rejected");
            expect(SessionHandleStore.row("answer-refuse").revision).toBe(destination.revision);
            expect(SessionHandleStore.tree("answer-refuse")).toHaveLength(destinationTree);
            expect(SessionHandleStore.requestById("answer-refuse:q")?.seenReplyIds).toEqual([
              "answer-refuse:reply-1",
              "answer-refuse:refuse-1",
            ]);
            await expect(
              port.answer({ ...reply(q, "corrupt-missing", 1_099), sessionId: "OTHER" }),
            ).rejects.toThrow("session not found: OTHER");
            expect(SessionHandleStore.requestById(q.requestId)?.state).toBe("open");
            expect(await port.answer(reply(q, "STALE:reply-1", 1_099))).toBe("resolved");
            // The winning input id replayed by a different principal is a
            // conflicting replay: refused without a record, the winner untouched.
            const settled = SessionHandleStore.tree(q.sessionId).length;
            expect(
              await port.answer({
                ...reply(q, "STALE:reply-1", 1_099),
                principal: { kind: "session", principalId: "impostor", evidenceId: "other" },
              }),
            ).toBe("rejected");
            expect(SessionHandleStore.tree(q.sessionId)).toHaveLength(settled);
            expect(
              SessionHandleStore.requestById(q.requestId)?.replies.map((r) => r.responderId),
            ).toEqual(["worker"]);
          },
        },
      ],
    });

    // Terminal uniqueness: exactly one `<requestId>:resolution` record per
    // session; the losing contender is exactly one duplicate record. No product
    // session ever holds a `rejected` record: only STALE is probed with
    // corrupt input, and a misrouted answer leaves nothing behind.
    for (const id of sessions) {
      const final = result.final.get(id);
      const records = resolutions(final);
      expect(records[0]).toEqual(["request", "opened"]);
      expect(final?.actions.filter((action) => action.id === `${id}:q:resolution`)).toHaveLength(1);
      expect(records.filter(([, resolution]) => resolution === "duplicate")).toHaveLength(1);
      expect(
        records.filter(
          ([, resolution]) => !["opened", "duplicate", undefined].includes(resolution as string),
        ),
      ).toHaveLength(2);
      expect(final?.requests[0]?.state).not.toBe("open");
    }
    const stale = result.final.get("STALE");
    expect(stale?.requests[0]).toMatchObject({ state: "resolved", outcome: "answered" });
    expect(resolutions(stale)).toEqual([
      ["request", "opened"],
      ["reply", "rejected"],
      ["reply", "rejected"],
      ["reply", "rejected"],
      ["reply", "resolved"],
      ["request", "resolved"],
      ["prompt", undefined],
    ]);
    // A misrouted answer is refused before any record: neither session keeps it.
    const misrouted = [...result.final.values()].flatMap((snapshot) =>
      snapshot.actions.filter((action) => action.id.includes("corrupt-session")),
    );
    expect(misrouted).toEqual([]);
    expect(resolutions(result.final.get("answer-refuse")).at(-1)).toEqual(["reply", "duplicate"]);
  });
});

/** 6.4 request races: one resolution per request, every losing input recorded once or refused. */
function assertRequestRaces(result: TraceResult): void {
  const late = result.final.get("QLATE");
  expect(late?.requests[0]).toMatchObject({
    state: "expired",
    outcome: "outcome_unknown",
    seenReplyIds: ["reply-1"],
  });
  // Late reply settles the request as outcome_unknown once; the delayed timer
  // is recorded once as a duplicate input, its retry commits nothing.
  expect(kinds(late).slice(4)).toEqual(["request", "reply", "request", "request"]);
  expect(
    late?.actions.slice(4).map((action) => objectValue(action.effect.value)?.resolution),
  ).toEqual(["opened", "late_unknown", "late_unknown", "duplicate"]);
  const cancelled = result.final.get("QCANCEL");
  expect(cancelled?.requests[0]).toMatchObject({
    state: "cancelled",
    outcome: "cancelled",
    seenReplyIds: ["reply-1"],
    replies: [],
  });
  expect(resolutions(cancelled)).toEqual([
    ["request", "opened"],
    ["request", "cancelled"],
    ["request", "cancelled"],
    ["reply", "duplicate"],
  ]);
  expect(cancelled?.inbox).toEqual([]);
  const answered = result.final.get("QANSWER");
  expect(answered?.requests[0]).toMatchObject({
    state: "resolved",
    outcome: "answered",
    replies: [{ replyId: "reply-1", responderId: "worker", content: "ok", receivedAt: 1_099 }],
  });
  // The winning reply is delivered to the turn as pending inbox input; the
  // later Owner cancel is recorded once as a duplicate and changes nothing.
  expect(resolutions(answered)).toEqual([
    ["request", "opened"],
    ["reply", "resolved"],
    ["request", "resolved"],
    ["prompt", undefined],
    ["request", "duplicate"],
  ]);
  expect(answered?.inbox.map((row) => [row.id, row.kind, row.status])).toEqual([
    ["reply-1", "prompt", "pending"],
  ]);
  const rejected = result.final.get("QREJECT");
  expect(rejected?.requests[0]).toMatchObject({ state: "open", seenReplyIds: [], replies: [] });
  expect(resolutions(rejected)).toEqual([
    ["request", "opened"],
    ["reply", "rejected"],
    ["reply", "rejected"],
    ["reply", "rejected"],
  ]);
}

/** The complete snapshot of `sessionId` after the named step; a missing one fails the trace. */
function named(result: TraceResult, step: string, sessionId: string): SessionSnapshot {
  const snapshot = result.named.get(step)?.get(sessionId);
  if (snapshot === undefined) throw new Error(`no ${sessionId} snapshot after ${step}`);
  return snapshot;
}

/** 6.4 child/parent loss boundary: the reply is delivered once across two recoveries. */
function assertLossBoundary(
  result: TraceResult,
  parentChild: ReturnType<typeof childParentFixture>,
): void {
  expect(named(result, "CP_SEALED", "CHILD").outbound).toMatchObject([
    { state: "pending", destinationReceipt: null },
  ]);
  expect(named(result, "CP_SEALED", "PARENT").inbox).toEqual([]);
  expect(named(result, "CP_RECEIVED", "CHILD").outbound.map((row) => row.state)).toEqual([
    "pending",
  ]);
  const receivedParent = named(result, "CP_RECEIVED", "PARENT");
  expect(receivedParent.inbox).toHaveLength(1);
  const ackedParent = named(result, "CP_ACKED", "PARENT");
  expect(ackedParent.actions).toEqual(receivedParent.actions);
  const [delivered] = named(result, "CP_ACKED", "CHILD").outbound;
  if (delivered === undefined) throw new Error("child lost its outbound obligation");
  expect(delivered).toMatchObject({
    state: "delivered",
    message: { replyTo: "mCR", destinationSessionId: "PARENT", terminal: "completed" },
  });
  expect(delivered.destinationReceipt?.id).toBe(delivered.message.messageId);
  expect(ackedParent.inbox.map((row) => row.id)).toEqual([delivered.message.messageId]);
  expect(parentChild.sent()).toHaveLength(2);
  expect(parentChild.sent()[0]).toBe(parentChild.sent()[1]);
  expect(parentChild.consumed()).toBe(1);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const owner: SessionTransition.Principal = {
  kind: "owner",
  principalId: "owner",
  evidenceId: "credential",
};

function requestOf(map: ReadonlyMap<string, SessionTransition.Request>, id: string) {
  const request = map.get(id);
  if (request === undefined) throw new Error(`no request for ${id}`);
  return request;
}

/**
 * An Owner cancel issued from outside a live handle: a fresh fenced lease around
 * the shared request commit, exactly like the gateway port's own transition.
 */
function cancelRequest(
  q: SessionTransition.Request,
  runtime: SessionRuntime,
): SessionTransition.Resolution {
  const controller = `conformance:control:${++nextId}`;
  const row = SessionHandleStore.row(q.sessionId);
  const lease = SessionHandleStore.acquireLease({
    sessionId: q.sessionId,
    owner: controller,
    expectedFence: row.leaseFence,
    now,
    expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
  });
  if (!lease.ok) throw new Error(`control lease ${lease.reason}`);
  try {
    return commitSessionRequest(
      q.sessionId,
      { owner: controller, fence: lease.fence },
      { kind: "request.cancel", requestId: q.requestId, principal: owner },
      `cancel-1:${q.sessionId}`,
      1_099,
      runtime,
    ).resolution;
  } finally {
    const current = SessionHandleStore.row(q.sessionId);
    SessionHandleStore.commit({
      sessionId: q.sessionId,
      owner: controller,
      fence: lease.fence,
      now,
      expectedRevision: current.revision,
      actions: [],
      consumeInboxIds: [],
      state: current.state,
      releaseLease: true,
    });
  }
}

function reply(
  q: SessionTransition.Request,
  inputId: string,
  receivedAt: number,
): SessionTransition.Answer {
  return {
    inputId,
    requestId: q.requestId,
    sessionId: q.sessionId,
    receivedAt,
    principal: { kind: "session", principalId: "worker", evidenceId: "worker-credential" },
    bindingDigest: q.bindingDigest,
    inputHash: q.inputHash,
    effectHash: q.effectHash,
    generation: q.generation,
    toolsHash: q.toolsHash,
    domainRevisions: q.domainRevisions,
    decision: "reply",
    allowedAction: "report_result",
    content: "ok",
  };
}

/** The immutable request prefix of 6.4: cfg, T, q-pre, q (a real tool intent with value {value:"B"}). */
function seedRequestSession(id: string): void {
  const created = SessionHandleStore.materialize({
    id,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 1,
    actionId: `${id}:cfg`,
    at: now,
  });
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(id));
  const lease = SessionHandleStore.acquireLease({
    sessionId: id,
    owner: "o",
    expectedFence: created.row.leaseFence,
    now,
    expiresAt: now + 30_000,
  });
  if (!lease.ok) throw new Error("seed lease refused");
  const turn = `${id}:T`;
  const committed = SessionHandleStore.commit({
    sessionId: id,
    owner: "o",
    fence: lease.fence,
    now,
    expectedRevision: created.row.revision,
    consumeInboxIds: [],
    state: "running",
    releaseLease: true,
    actions: [
      {
        id: turn,
        sessionId: id,
        parentId: `${id}:cfg`,
        kind: "turn",
        intent: {
          encodingVersion: 1,
          value: {
            phase: "intent",
            resultId: `${id}:R`,
            inboxIds: [],
            resumeCount: 0,
            boundaryActionId: `${id}:cfg`,
            toolsGeneration: generation.generation,
            toolsHash: generation.toolsHash,
            systemHash: generation.systemHash,
            policyGeneration: 1,
          },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: now,
        irreversible: true,
      },
      {
        id: `${id}:q-pre`,
        sessionId: id,
        parentId: turn,
        kind: "policy.decision",
        intent: {
          encodingVersion: 1,
          value: {
            hook: "tool.pre",
            op: "B",
            generation: 1,
            matchedRuleIds: [],
            verdict: "allow",
            inputHash: canonicalDigest({ value: "B" }),
          },
        },
        effect: { encodingVersion: 1, value: { phase: "result", reason: null } },
        ts: now,
        irreversible: true,
      },
      {
        id: `${id}:q`,
        sessionId: id,
        parentId: turn,
        kind: "tool",
        intent: {
          encodingVersion: 1,
          value: {
            phase: "intent",
            op: "B",
            value: { value: "B" },
            effectHash: canonicalDigest({ category: "query" }),
            callId: "B",
            turnId: turn,
            waveId: `${id}:q`,
          },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: now,
        irreversible: true,
      },
    ],
  });
  if (!committed.ok) throw new Error(`seed commit ${committed.reason}`);
}

function openRequest(port: ReturnType<typeof createSessionRequests>, id: string) {
  const request = port.open({
    requestId: `${id}:q`,
    sessionId: id,
    expectedResponders: ["worker"],
    correlation: { channelId: "ch", replyToMessageId: "platform-1" },
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    deadline: 1_100,
    at: now,
  });
  expect(request.state).toBe("open");
  return request;
}

/** Crash-open seed of 6.2: dead owner, T pinned to G1 while the row already points at G2. */
function seedCrashOpen(id: string): void {
  const created = SessionHandleStore.materialize({
    id,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 1,
    actionId: "cfg",
    at: now,
  });
  const g1 = SessionHandleStore.latestGeneration(SessionHandleStore.tree(id));
  const lease = SessionHandleStore.acquireLease({
    sessionId: id,
    owner: "dead",
    expectedFence: created.row.leaseFence,
    now,
    expiresAt: now + 10,
  });
  if (!lease.ok) throw new Error("dead lease refused");
  const g2 = SessionHandleStore.generationSnapshot({
    generation: g1.generation + 1,
    revertTo: g1.generation,
    tools: [],
    system: { preset: "", blocks: [{ id: "b", source: "fixture", content: "v2" }] },
    policyGeneration: 1,
  });
  const committed = SessionHandleStore.commit({
    sessionId: id,
    owner: "dead",
    fence: lease.fence,
    now,
    expectedRevision: created.row.revision,
    consumeInboxIds: [],
    state: "running",
    releaseLease: false,
    generation: {
      toolsGeneration: g2.generation,
      systemHash: g2.systemHash,
      policyGeneration: g2.policyGeneration,
    },
    actions: [
      {
        id: "T",
        sessionId: id,
        parentId: "cfg",
        kind: "turn",
        intent: {
          encodingVersion: 1,
          value: {
            phase: "intent",
            resultId: "R",
            inboxIds: [],
            resumeCount: 0,
            boundaryActionId: "cfg",
            toolsGeneration: g1.generation,
            toolsHash: g1.toolsHash,
            systemHash: g1.systemHash,
            policyGeneration: 1,
          },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: now,
        irreversible: true,
      },
      SessionHandleStore.configureAction({
        id: "cfg2",
        sessionId: id,
        parentId: "T",
        operation: "system.blocks.set",
        snapshot: g2,
        at: now + 1,
      }),
    ],
  });
  if (!committed.ok) throw new Error(`crash seed ${committed.reason}`);
}

/** Child/parent loss boundary of 6.4 on two real session histories and the real outbound path. */
function childParentFixture() {
  const sent: string[] = [];
  let consumed = 0;
  const parentRunner: SessionRunner = async () => {
    consumed += 1;
    return { kind: "result", text: "received" };
  };
  function runtime(loseAck: boolean, dispatch: boolean): SessionRuntime {
    const value = runtimeFor({
      async dispatchOutbound({ message }) {
        if (!dispatch) throw new Error("process died before wake");
        sent.push(JSON.stringify(message));
        const received = SessionHandleStore.commitReceivedMessage({
          id: message.messageId,
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: message.content,
          origin: { encodingVersion: 1, value: message },
          createdAt: now,
          parentActionId: null,
        });
        await wakeSession(message.destinationSessionId, parentRunner, value);
        if (loseAck) throw new Error("source ack lost");
        return received.receipt;
      },
    });
    return value;
  }
  return {
    sent: () => sent,
    consumed: () => consumed,
    async sealWithoutWake() {
      const first = runtime(false, false);
      session({ id: "PARENT", role: "resident", runner: parentRunner }, first);
      const child = session(
        {
          id: "CHILD",
          parentId: "PARENT",
          role: "worker",
          runner: async () => ({ kind: "result", text: "done" }),
        },
        first,
      );
      // The parent's real source action: the reply observation resolves it.
      const source = SessionHandleStore.tree("PARENT")[0]?.id;
      if (source === undefined) throw new Error("parent has no source action");
      await expect(
        child.prompt("hello", {
          encodingVersion: 1,
          value: {
            kind: "message",
            messageId: "mCR",
            senderSessionId: "PARENT",
            sourceActionId: source,
          },
        }),
      ).rejects.toThrow("process died before wake");
      await closeSessions(first);
      runtimes.splice(runtimes.indexOf(first), 1);
    },
    async recoverLosingAck() {
      now = 2_000;
      const second = runtime(true, true);
      await expect(
        sweepSessions((row) => (row.id === "PARENT" ? parentRunner : rejectReplay), second),
      ).rejects.toThrow("source ack lost");
      await closeSessions(second);
      runtimes.splice(runtimes.indexOf(second), 1);
    },
    async recoverAndAck() {
      now = 33_000;
      const third = runtime(false, true);
      await sweepSessions((row) => (row.id === "PARENT" ? parentRunner : rejectReplay), third);
      await closeSessions(third);
      runtimes.splice(runtimes.indexOf(third), 1);
    },
  };
}

const rejectReplay: SessionRunner = async () => {
  throw new Error("sealed child replayed");
};
