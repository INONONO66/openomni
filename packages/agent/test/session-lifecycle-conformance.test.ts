import { isolated } from "./helpers/isolated";
import { failure } from "./helpers/effect-g1";
import { ForeignFailure, type ExecutionError, type SessionError } from "../src/errors";
import type { SessionHandle } from "../src/session-contract";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { receiveOutbound } from "./helpers/effect-g2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Alarm, type BusEvent, canonicalDigest, type Inbox, type LedgerAction, type LedgerSession, L0Observation, type ObservationSink, type PlainValue, type PolicyRow, type SessionTransition, type SessionTurn, } from "@openomni/protocol";
import { createExecutor } from "../src/index";
import type { ExecutionApprovalRequest, ExecutionApprovals, ExecutionBatchResult, } from "../src/executor";
import { closeSessions, session, type SessionRunner, type SessionRunnerInput, type SessionRunnerResult, type SessionRuntime, sweepSessions, wakeSession, } from "../src/session-handle";
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
const SIGNAL_TIMEOUT_MS = 2000;
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
            for (const waiter of this.waiters.splice(0))
                waiter(committed);
            return;
        }
        const call = ToolEventCall.safeParse(data);
        if (!call.success)
            return;
        if (event.name === "tool.execution.started")
            this.started.push(call.data.toolCallId);
        if (event.name === "tool.execution.completed")
            this.completed.push(call.data.toolCallId);
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
            if (match(committed))
                ready.resolve();
            else
                this.waiters.push(waiter);
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
    if (!SessionHandleStore.listRows().some((row: LedgerSession.Row) => row.id === sessionId))
        return undefined;
    return {
        row: SessionHandleStore.row(sessionId),
        actions: SessionHandleStore.tree(sessionId),
        inbox: SessionHandleStore.inboxRows(sessionId),
        requests: SessionHandleStore.requestRows(sessionId),
        outbound: SessionHandleStore.outboundRows(sessionId),
        tail: SessionHandleStore.getSnapshot(sessionId, 4),
    };
}
function objectValue(value: LedgerAction.Node["intent"]["value"]): Record<string, LedgerAction.Node["intent"]["value"]> | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value;
}
function phaseOf(action: LedgerAction.Node): string | undefined {
    const phase = objectValue(action.effect.value)?.phase;
    return typeof phase === "string" ? phase : undefined;
}
function assertAppendOnly(before: SessionSnapshot | undefined, after: SessionSnapshot): void {
    if (before === undefined)
        return;
    expect(after.actions.slice(0, before.actions.length)).toEqual([...before.actions]);
    expect(after.inbox.length).toBeGreaterThanOrEqual(before.inbox.length);
}
function assertCausalLinks(after: SessionSnapshot): void {
    const seen = new Set<string>();
    for (const action of after.actions) {
        expect(action.sessionId).toBe(after.row.id);
        if (action.parentId !== null)
            expect(seen.has(action.parentId)).toBe(true);
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
    for (const count of [...turnTerminals.values(), ...toolResults.values()])
        expect(count).toBe(1);
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
        expect(after.actions.some((action: LedgerAction.Node) => action.id === row.id)).toBe(true);
        expect(deliveries.get(row.id) ?? 0).toBeLessThanOrEqual(1);
        if (row.status === "pending") {
            expect(row.consumedBy).toBeNull();
            expect(deliveries.has(row.id)).toBe(false);
        }
        else
            expect(row.consumedBy).not.toBeNull();
    }
}
function assertObservations(before: SessionSnapshot | undefined, after: SessionSnapshot, events: readonly L0Observation.ActionCommitted[]): void {
    const appended = after.actions.slice(before?.actions.length ?? 0);
    // Storage and executor may both notify one commit; two notifications are not two actions.
    const observed = events.filter((committed: L0Observation.ActionCommitted, index: number) => committed.sessionId === after.row.id &&
        events.findIndex((other: L0Observation.ActionCommitted) => other.id === committed.id) === index);
    expect(observed.map((committed: L0Observation.ActionCommitted) => [committed.id, committed.kind])).toEqual(appended.map((action: LedgerAction.Node) => [action.id, action.kind]));
    for (const committed of observed) {
        expect(committed.revision).toBeGreaterThan(before?.row.revision ?? 0);
        expect(committed.revision).toBeLessThanOrEqual(after.row.revision);
    }
}
interface TraceStep {
    readonly name: string;
    run(): Effect.Effect<void, SessionError | Error, Scope.Scope>;
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
let now = 1000;
let nextId = 0;
const runtimes: SessionRuntime[] = [];
function runtimeFor(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
    const runtime: SessionRuntime = {
        observations: sink,
        clock: () => now,
        entropy: () => `id-${++nextId}`,
        processId: "conformance",
        scheduleHeartbeat: () => () => undefined,
        authorizeApproval: () => Effect.succeed({
            kind: "owner" as const,
            principalId: "owner",
            evidenceId: "credential",
        }),
        ...overrides,
    };
    runtimes.push(runtime);
    return runtime;
}
/** Section 6 harness entry: runs the vector, checks every prefix, then proves effect-free replay. */
export function runLifecycleTrace(trace: Trace) {
    return Effect.gen(function* () {
        const named = new Map<string, ReadonlyMap<string, SessionSnapshot>>();
        const previous = new Map<string, SessionSnapshot>();
        for (const sessionId of trace.sessions) {
            const seed = snapshotOf(sessionId);
            if (seed === undefined)
                continue;
            assertCausalLinks(seed);
            previous.set(sessionId, seed);
        }
        for (const step of trace.steps) {
            const mark = sink.committedEvents.length;
            (yield* toEffect(step.run()));
            const events = sink.committedEvents.slice(mark);
            const current = new Map<string, SessionSnapshot>();
            for (const sessionId of trace.sessions) {
                const after = snapshotOf(sessionId);
                if (after === undefined)
                    continue;
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
        (yield* toEffect(replayEffectFree(previous, trace.dispatched)));
        return { named, final: previous };
    });
}
/** Reopen the committed image: the fold equals the last prefix, dispatch and observations stay empty. */
function replayEffectFree(expected: ReadonlyMap<string, SessionSnapshot>, dispatched: () => number) {
    return Effect.gen(function* () {
        for (const runtime of runtimes.splice(0))
            (yield* toEffect(closeSessions(runtime)));
        const bodies = dispatched();
        const mark = sink.committedEvents.length;
        sink.resetToolTape();
        Storage.reset();
        Storage.initialize({ dbPath, observationSink: sink });
        for (const [sessionId, snapshot] of expected) {
            const replayed = snapshotOf(sessionId);
            if (replayed === undefined)
                throw new Error(`replay lost session ${sessionId}`);
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
    });
}
function kinds(snapshot: SessionSnapshot | undefined): string[] {
    return (snapshot?.actions ?? []).map((action: LedgerAction.Node) => action.kind);
}
/** `[kind, resolution]` of every action after the four-action request seed. */
function resolutions(snapshot: SessionSnapshot | undefined): [
    string,
    PlainValue | undefined
][] {
    return (snapshot?.actions ?? [])
        .slice(4)
        .map((action: LedgerAction.Node) => [action.kind, objectValue(action.effect.value)?.resolution]);
}
function hookOf(sessionId: string, actionId: string): string | undefined {
    const action = SessionHandleStore.tree(sessionId).find((node: LedgerAction.Node) => node.id === actionId);
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
    readonly handle: SessionHandle;
    readonly runtime: SessionRuntime;
    readonly tape: WaveCall[];
    readonly entered: Record<WaveCall, Signal<void>>;
    readonly gates: Record<WaveCall, Signal<void>>;
    readonly results: Signal<readonly ExecutionBatchResult[]>;
    readonly settled: Signal<Exit.Exit<readonly ExecutionBatchResult[], ExecutionError>>;
    readonly approvals: Signal<ExecutionApprovals>;
    dispatched(): number;
}
function waveSession(id: string, overrides: Partial<SessionRuntime> = {}) {
    return Effect.gen(function* () {
        const tape: WaveCall[] = [];
        const entered = { A: signal<void>(), B: signal<void>(), C: signal<void>(), D: signal<void>() };
        const gates = { A: signal<void>(), B: signal<void>(), C: signal<void>(), D: signal<void>() };
        const results = signal<readonly ExecutionBatchResult[]>();
        const settled = signal<Exit.Exit<readonly ExecutionBatchResult[], ExecutionError>>();
        const approvals = signal<ExecutionApprovals>();
        const runtime = runtimeFor(overrides);
        const runner: SessionRunner = (input: SessionRunnerInput) => Effect.gen(function* () {
            const executor = waveExecutor(input, runtime);
            if (executor.approvals === undefined)
                throw new Error("executor without approvals");
            input.bindApprovals?.(executor.approvals);
            approvals.resolve(executor.approvals);
            // The session owns this wave's fiber; interruption must finish its
            // durable terminal cleanup before the turn can seal.
            const wave = executor.runBatch(WAVE.map((call: WaveCall) => ({
                request: {
                    kind: "tool",
                    op: call,
                    intent: { value: call },
                    effect: { category: "query" },
                    toolObservation: { turnId: input.turnId, callId: call },
                },
                ...(call === "D" ? { sequential: true as const } : {}),
                body() {
                    return Effect.gen(function* () {
                        entered[call].resolve();
                        (yield* toEffect(gates[call].promise));
                        tape.push(call);
                        return { status: "success", output: call };
                    });
                },
            })), { signal: input.signal });
            // The Effect runner owns the wave lifetime; the session tracks its fibers directly.

            const outcome = yield* wave.pipe(Effect.onExit((exit: Exit.Exit<readonly ExecutionBatchResult[], ExecutionError>) => Effect.sync(() => settled.resolve(exit))));
            results.resolve(outcome);
            if (input.signal.aborted)
                return { kind: "interrupted" };
            return { kind: "result", text: outcome.map((slot: ExecutionBatchResult) => slot.terminal).join(",") };
        });
        const handle = (yield* session({ id, role: "resident", runner }, runtime));
        return {
            handle,
            runtime,
            tape,
            entered,
            gates,
            results,
            settled,
            approvals,
            dispatched: () => tape.length,
        };
    });
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
function openWaveAtApproval(fixture: WaveFixture, text: string) {
    return Effect.gen(function* () {
        sink.resetToolTape();
        const requested = sink.committed((committed: L0Observation.ActionCommitted) => committed.sessionId === fixture.handle.id && committed.kind === "request");
        const running = (yield* Effect.forkScoped(fixture.handle.prompt(text)));
        (yield* waitFor(requested, "approval request commit"));
        const approvals = (yield* waitFor(fixture.approvals.promise, "bound approvals"));
        const pending = approvals.pending()[0];
        if (pending === undefined)
            throw new Error("missing pending approval");
        expect(fixture.tape).toEqual([]);
        expect(sink.started).toEqual([]);
        return { running, approvals, pending };
    });
}
function releaseBodies(fixture: WaveFixture, order: readonly WaveCall[]) {
    return Effect.gen(function* () {
        const parallel = order.filter((call: WaveCall) => call !== "D");
        (yield* waitFor(Promise.all(parallel.map((call: WaveCall) => fixture.entered[call].promise)), "parallel body entry"));
        expect(sink.started).toEqual([...parallel].sort());
        expect(sink.completed).toEqual([]);
        for (const call of parallel)
            fixture.gates[call].resolve();
        (yield* waitFor(fixture.entered.D.promise, "sequential body entry after the parallel barrier"));
        expect(fixture.tape).toEqual([...parallel]);
        expect(SessionHandleStore.tree(fixture.handle.id).some((action: LedgerAction.Node) => action.kind === "tool" && phaseOf(action) === "result")).toBe(false);
        fixture.gates.D.resolve();
    });
}
/** `kind:phase` per committed action: the shape of a named snapshot's history. */
function shape(snapshot: SessionSnapshot | undefined): string[] {
    return (snapshot?.actions ?? []).map((action: LedgerAction.Node) => `${action.kind}:${phaseOf(action) ?? "-"}`);
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
    test("lifecycle v1 ordinary and mixed-wave approved", () => traceTest(() => Effect.gen(function* () {
        seedPolicy([approvalRule]);
        const ordinary = runtimeFor();
        const gate = signal<void>();
        const plain = (yield* session({
            id: "S",
            role: "resident",
            runner: () => Effect.gen(function* () {
                (yield* toEffect(gate.promise));
                return { kind: "result", text: "done" };
            }),
        }, ordinary));
        const wave = (yield* waveSession("W"));
        let plainRunning: Fiber.RuntimeFiber<SessionRunnerResult | undefined, SessionError> | undefined;
        let wavePending: ExecutionApprovalRequest | undefined;
        let waveRunning: Fiber.RuntimeFiber<SessionRunnerResult | undefined, SessionError> | undefined;
        let waveApprovals: ExecutionApprovals | undefined;
        const result = (yield* toEffect(runLifecycleTrace({
            sessions: ["S", "W"],
            dispatched: wave.dispatched,
            steps: [
                { name: "BASE", run: () => Effect.gen(function* () {
                        return (yield* toEffect(undefined));
                    }) },
                {
                    name: "RUN",
                    run: () => Effect.gen(function* () {
                        const entered = sink.committed((committed: L0Observation.ActionCommitted) => committed.sessionId === "S" && hookOf("S", committed.id) === "turn.pre");
                        plainRunning = (yield* Effect.forkScoped(plain.prompt("hello")));
                        (yield* waitFor(entered, "turn pre decision"));
                    }),
                },
                {
                    name: "DONE",
                    run: () => Effect.gen(function* () {
                        const sealed = sink.committed((committed: L0Observation.ActionCommitted) => committed.sessionId === "S" &&
                            SessionHandleStore.turnTerminal(SessionHandleStore.tree("S").find((action: LedgerAction.Node) => action.id === committed.id)) !== undefined);
                        gate.resolve();
                        (yield* waitFor(sealed, "terminal result"));
                        expect((yield* waitFor(plainRunning ?? Promise.reject(new Error("no run")), "result"))).toEqual({
                            kind: "result",
                            text: "done",
                        });
                    }),
                },
                {
                    name: "WAIT",
                    run: () => Effect.gen(function* () {
                        const opened = (yield* toEffect(openWaveAtApproval(wave, "wave")));
                        wavePending = opened.pending;
                        waveRunning = opened.running;
                        waveApprovals = opened.approvals;
                    }),
                },
                {
                    name: "APPROVED",
                    run: () => Effect.gen(function* () {
                        if (wavePending === undefined || waveApprovals === undefined)
                            throw new Error("no wait");
                        (yield* toEffect(waveApprovals.answer({
                            request: wavePending,
                            credential: "owner-token",
                            decision: "approve",
                        })));
                    }),
                },
                {
                    name: "WAVE_APPROVED",
                    run: () => Effect.gen(function* () {
                        (yield* toEffect(releaseBodies(wave, ["C", "A", "B", "D"])));
                        expect((yield* waitFor(waveRunning ?? Promise.reject(new Error("no run")), "wave"))).toEqual({
                            kind: "result",
                            text: "executed,executed,executed,executed",
                        });
                        expect(sink.completed).toEqual(["A", "B", "C", "D"]);
                    }),
                },
            ],
        })));
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
        expect(done?.inbox.map((row: Inbox.Row) => row.status)).toEqual(["consumed"]);
        expect(done?.tail.turns.at(-1)).toMatchObject({
            state: "idle",
            messages: [
                { role: "user", text: "hello" },
                { role: "assistant", text: "done" },
            ],
        });
        const wait = result.named.get("WAIT")?.get("W");
        expect(shape(wait)).toEqual([...TURN_PREFIX, ...WAVE_PRE, ...WAVE_INTENT, "request:state"]);
        expect(wait?.requests.map((request: SessionTransition.Request) => request.state)).toEqual(["open"]);
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
        expect(approved?.requests.map((request: SessionTransition.Request) => [request.state, request.outcome])).toEqual([
            ["resolved", "answered"],
        ]);
        const results = (yield* waitFor(wave.results.promise, "wave results"));
        expect(results).toEqual(WAVE.map((call: WaveCall) => ({ terminal: "executed", value: { status: "success", output: call } })));
        expect(wave.tape).toEqual(["C", "A", "B", "D"]);
        const resultsInOrder = (approved?.actions ?? [])
            .filter((action: LedgerAction.Node) => action.kind === "tool" && phaseOf(action) === "result")
            .map((action: LedgerAction.Node) => objectValue(action.effect.value)?.callId);
        expect(resultsInOrder).toEqual(["A", "B", "C", "D"]);
    })));
    test("lifecycle v1 refusal timeout and interrupt", () => traceTest(() => Effect.gen(function* () {
        seedPolicy([approvalRule]);
        const refused = (yield* waveSession("REFUSED"));
        const timed = (yield* waveSession("TIMED", { approvalTimeoutMs: 100 }));
        const interrupted = (yield* waveSession("INTERRUPTED"));
        const timedPort = createSessionRequests(timed.runtime);
        const runs = new Map<string, Fiber.RuntimeFiber<SessionRunnerResult | undefined, SessionError>>();
        const result = (yield* toEffect(runLifecycleTrace({
            sessions: ["REFUSED", "TIMED", "INTERRUPTED"],
            dispatched: () => refused.dispatched() + timed.dispatched() + interrupted.dispatched(),
            steps: [
                {
                    name: "REFUSE",
                    run: () => Effect.gen(function* () {
                        const opened = (yield* toEffect(openWaveAtApproval(refused, "refuse")));
                        runs.set("REFUSED", opened.running);
                        (yield* toEffect(opened.approvals.answer({
                            request: opened.pending,
                            credential: "owner-token",
                            decision: "refuse",
                        })));
                        expect((yield* failure(opened.approvals.answer({
                            request: opened.pending,
                            credential: "owner-token",
                            decision: "approve",
                        })))).toMatchObject({ code: "stale_approval" });
                    }),
                },
                {
                    name: "WAVE_REFUSED",
                    run: () => Effect.gen(function* () {
                        (yield* toEffect(releaseBodies(refused, ["C", "A", "D"])));
                        (yield* waitFor(runs.get("REFUSED") ?? Promise.reject(new Error("no run")), "refused"));
                    }),
                },
                {
                    name: "TIMED",
                    run: () => Effect.gen(function* () {
                        const opened = (yield* toEffect(openWaveAtApproval(timed, "timeout")));
                        runs.set("TIMED", opened.running);
                        now = 1100;
                        // The durable deadline fires once; the delayed duplicate timer and
                        // the late approve both lose to the committed expiry.
                        (yield* timedPort.timeout(opened.pending.id, now));
                        (yield* timedPort.timeout(opened.pending.id, now));
                        yield* waitFor(timed.entered.A.promise, "approval timeout observed by the wave");
                        expect((yield* failure(opened.approvals.answer({
                            request: opened.pending,
                            credential: "owner-token",
                            decision: "approve",
                        })))).toMatchObject({ code: "stale_approval" });
                    }),
                },
                {
                    name: "WAVE_TIMEOUT",
                    run: () => Effect.gen(function* () {
                        (yield* toEffect(releaseBodies(timed, ["C", "A", "D"])));
                        (yield* waitFor(runs.get("TIMED") ?? Promise.reject(new Error("no run")), "timed"));
                    }),
                },
                {
                    name: "WAVE_INTERRUPTED",
                    run: () => Effect.gen(function* () {
                        now = 1000;
                        const opened = (yield* toEffect(openWaveAtApproval(interrupted, "interrupt")));
                        const aborted = interrupted.settled.promise;
                        (yield* toEffect(interrupted.handle.interrupt()));
                        const exit = yield* waitFor(aborted, "interrupted wave");
                        expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
                        (yield* waitFor(opened.running, "interrupted turn"));
                    }),
                },
            ],
        })));
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
        for (const [id, reason, state] of [
            ["REFUSED", "approval_refused", "refused"],
            ["TIMED", "approval_timeout", "expired"],
        ] as const) {
            const final = result.final.get(id);
            expect(shape(final)).toEqual([
                ...TURN_PREFIX,
                ...WAVE_PRE,
                ...WAVE_INTENT,
                ...(id === "REFUSED"
                    ? ["request:state", "reply:state", "request:state"]
                    : ["request:state", "request:state", "request:state"]),
                ...blockedTail,
            ]);
            expect(final?.row).toMatchObject({ revision: 30, state: "idle", leaseOwner: null });
            const blocked = final?.actions.find((action: LedgerAction.Node) => action.kind === "tool" && objectValue(action.effect.value)?.terminal === "blocked_pre");
            expect(blocked === undefined ? undefined : objectValue(blocked.effect.value)).toMatchObject({
                callId: "B",
                reason,
            });
            expect(final?.requests.map((request: SessionTransition.Request) => [request.state, request.outcome])).toEqual([
                [state, id === "REFUSED" ? "denied" : "outcome_unknown"],
            ]);
        }
        expect((yield* waitFor(refused.results.promise, "refused results"))).toMatchObject([
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
            "inbox.deliver:delivery",
            "turn:terminal",
        ]);
        expect(cancelled?.row).toMatchObject({ revision: 25, state: "interrupted" });
        expect(cancelled?.requests.map((request: SessionTransition.Request) => [request.state, request.outcome])).toEqual([
            ["cancelled", "cancelled"],
        ]);
        expect(cancelled?.actions.flatMap((action: LedgerAction.Node) => action.kind === "tool" && phaseOf(action) === "result"
            ? [objectValue(action.effect.value)?.terminal]
            : [])).toEqual(["interrupted", "blocked_pre", "interrupted", "interrupted"]);
        expect(cancelled?.inbox.map((row: Inbox.Row) => [row.kind, row.status])).toEqual([
            ["prompt", "consumed"],
            ["interrupt", "consumed"],
        ]);
    })));
    test("lifecycle v1 terminal resume differs from crash-open recovery", () => traceTest(() => Effect.gen(function* () {
        const runtime = runtimeFor();
        const entered = signal<SessionRunnerInput>();
        const aborted = signal<void>();
        const resumedEntry = signal<SessionRunnerInput>();
        let entries = 0;
        const runner: SessionRunner = (input: SessionRunnerInput) => Effect.gen(function* () {
            entries += 1;
            if (entries === 1) {
                input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
                entered.resolve(input);
                (yield* toEffect(aborted.promise));
                return { kind: "result", text: "late" };
            }
            resumedEntry.resolve(input);
            return { kind: "result", text: "resumed" };
        });
        const handle = (yield* session({ id: "S", role: "resident", runner }, runtime));
        let firstInput: SessionRunnerInput | undefined;
        let recovered: SessionRunnerInput | undefined;
        const result = (yield* toEffect(runLifecycleTrace({
            sessions: ["S", "C"],
            dispatched: () => entries,
            steps: [
                {
                    name: "INTERRUPTED",
                    run: () => Effect.gen(function* () {
                        const running = (yield* Effect.forkScoped(handle.prompt("hello")));
                        firstInput = (yield* waitFor(entered.promise, "runner entry"));
                        (yield* toEffect(handle.interrupt()));
                        (yield* waitFor(running, "interrupted seal"));
                        expect(handle.get().state).toBe("interrupted");
                    }),
                },
                {
                    name: "RESUME_DONE",
                    run: () => Effect.gen(function* () {
                        now = 1050;
                        (yield* toEffect(handle.system.blocks.set([{ id: "b", source: "fixture", content: "v2" }])));
                        (yield* toEffect(handle.resume()));
                        recovered = (yield* waitFor(resumedEntry.promise, "resumed entry"));
                    }),
                },
                {
                    name: "CRASH_OPEN",
                    run: () => Effect.gen(function* () {
                        (yield* seedCrashOpen("C"));
                    }),
                },
                {
                    name: "CRASH_DONE",
                    run: () => Effect.gen(function* () {
                        now = 2000;
                        const swept = signal<SessionRunnerInput>();
                        (yield* waitFor(sweepSessions(() => (input: SessionRunnerInput) => Effect.sync(() => {
                            swept.resolve(input);
                            return { kind: "result", text: "recovered" };
                        }), runtime), "boot sweep"));
                        const input = (yield* waitFor(swept.promise, "sweep entry"));
                        expect(input).toMatchObject({ resultId: "R", resumeCount: 1, toolsGeneration: 1 });
                        expect(SessionHandleStore.row("C").toolsGeneration).toBe(2);
                        const stale = () => SessionHandleStore.commit({
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
                        expect(yield* failure(stale())).toMatchObject({ _tag: "CommitRefused", reason: "fence", currentFence: 2 });
                    }),
                },
            ],
        })));
        const interrupted = result.named.get("INTERRUPTED")?.get("S");
        const terminal = interrupted?.actions.find((a: LedgerAction.Node) => SessionHandleStore.turnTerminal(a) !== undefined);
        expect(SessionHandleStore.turnTerminal(terminal)).toMatchObject({
            kind: "interrupted",
            resumeCount: 0,
        });
        expect(terminal?.id).toBe(firstInput?.resultId);
        expect(interrupted?.actions.some((a: LedgerAction.Node) => a.kind === "turn" &&
            phaseOf(a) === "terminal" &&
            objectValue(a.effect.value)?.text === "late")).toBe(false);
        const resumed = result.named.get("RESUME_DONE")?.get("S");
        expect(recovered?.turnId).not.toBe(firstInput?.turnId);
        expect(recovered?.resultId).not.toBe(firstInput?.resultId);
        // Resume keeps the interrupted turn's history: the new turn sees "hello".
        expect(recovered).toMatchObject({ resumeCount: 1, toolsGeneration: 2 });
        expect(recovered?.messages.map((message: SessionRunnerInput["messages"][number]) => [message.role, message.text])).toEqual([
            ["user", "hello"],
        ]);
        expect(resumed?.row).toMatchObject({ state: "idle", toolsGeneration: 2, leaseFence: 3 });
        expect(resumed?.inbox.map((row: Inbox.Row) => [row.kind, row.status])).toEqual([
            ["prompt", "consumed"],
            ["interrupt", "consumed"],
            ["resume", "consumed"],
        ]);
        expect(resumed?.tail.turns.map((turn: SessionTurn.Snapshot["turns"][number]) => turn.terminal?.kind)).toEqual([
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
    })));
    test("lifecycle v1 delayed timer cancel reply and duplicate input", () => traceTest(() => Effect.gen(function* () {
        const runtime = runtimeFor();
        const port = createSessionRequests(runtime);
        const ids = ["QLATE", "QCANCEL", "QANSWER", "QREJECT"] as const;
        const opened = new Map<string, SessionTransition.Request>();
        const parentChild = childParentFixture();
        const result = (yield* toEffect(runLifecycleTrace({
            sessions: [...ids, "PARENT", "CHILD"],
            dispatched: () => parentChild.consumed(),
            steps: [
                // The loss-boundary sweep recovers every open turn in the store, so it
                // runs before the request fixtures open their own turns.
                { name: "CP_SEALED", run: () => Effect.gen(function* () {
                        return (yield* toEffect(parentChild.sealWithoutWake()));
                    }) },
                { name: "CP_RECEIVED", run: () => Effect.gen(function* () {
                        return (yield* toEffect(parentChild.recoverLosingAck()));
                    }) },
                { name: "CP_ACKED", run: () => Effect.gen(function* () {
                        return (yield* toEffect(parentChild.recoverAndAck()));
                    }) },
                {
                    name: "QOPEN",
                    run: () => Effect.gen(function* () {
                        now = 1000;
                        for (const id of ids) {
                            (yield* seedRequestSession(id));
                            opened.set(id, (yield* openRequest(port, id)));
                        }
                    }),
                },
                {
                    name: "QLATE",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QLATE");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1100))))).toBe("late_unknown");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1100))))).toBe("late_unknown");
                        (yield* port.timeout(q.requestId, 1100));
                        (yield* port.timeout(q.requestId, 1100));
                    }),
                },
                {
                    name: "QCANCEL_REPLY",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QCANCEL");
                        expect((yield* cancelRequest(q, runtime))).toBe("cancelled");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1099))))).toBe("duplicate");
                    }),
                },
                {
                    name: "QANSWER",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QANSWER");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1099))))).toBe("resolved");
                        expect((yield* cancelRequest(q, runtime))).toBe("duplicate");
                        expect((yield* toEffect(port.answer(reply(q, "reply-1", 1099))))).toBe("resolved");
                        expect((yield* toEffect(port.answer({ ...reply(q, "reply-1", 1099), content: "altered" })))).toBe("rejected");
                    }),
                },
                {
                    name: "QREJECT",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "QREJECT");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "reject-who", 1099),
                            principal: { kind: "session", principalId: "stranger", evidenceId: "e" },
                        })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "reject-input", 1099),
                            inputHash: canonicalDigest({ value: "altered" }),
                        })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "reject-domain", 1099),
                            domainRevisions: { person: 5 },
                        })))).toBe("rejected");
                    }),
                },
            ],
        })));
        assertRequestRaces(result);
        assertLossBoundary(result, parentChild);
    })));
    test("lifecycle v1 alarm takeover pause rearm and dedupe", () => traceTest(() => Effect.gen(function* () {
        const alarms = Storage.get().alarms;
        if (alarms === undefined)
            throw new Error("missing alarm adapter");
        (yield* SessionHandleStore.materialize({
            id: "S",
            parentId: null,
            role: "resident",
            tools: [],
            system: { preset: "", blocks: [] },
            policyGeneration: 1,
            actionId: "cfg",
            at: now,
        }));
        const fire = (epoch: number, fence: number, sourceKey: string, content: string, at: number) => alarms.fire({
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
        const evaluate = (fired: ReturnType<typeof fire>) => fired.pipe(Effect.tap(() => Effect.sync(() => { evaluations += 1; })));
        const result = (yield* toEffect(runLifecycleTrace({
            sessions: ["S"],
            dispatched: () => evaluations,
            steps: [
                {
                    name: "A_ARM",
                    run: () => Effect.gen(function* () {
                        expect((yield* alarms.arm({
                            id: "A",
                            sessionId: "S",
                            kind: "watch",
                            fireAt: 1000,
                            spec: {
                                encodingVersion: 1,
                                value: {
                                    watch: { command: "poll", description: "watch-1", persistent: true },
                                    notificationLimit: 2,
                                    policyGeneration: 1,
                                },
                            },
                        }))).toMatchObject({ status: "armed", epoch: 1, fence: 0, notifications: 0 });
                    }),
                },
                {
                    name: "A_LEASE",
                    run: () => Effect.gen(function* () {
                        expect((yield* alarms.acquire("A", 0))).toMatchObject({ fence: 1 });
                        expect((yield* Effect.exit(alarms.acquire("A", 0)))._tag).toBe("Failure");
                    }),
                },
                {
                    name: "A_OPEN",
                    run: () => Effect.gen(function* () {
                        const first = yield* evaluate(fire(1, 1, "poll-1", "A", 1000));
                        expect(first?.receipts.map((receipt: LedgerAction.Receipt) => receipt.action.id)).toEqual([
                            Alarm.occurrenceId("A", 1, "poll-1"),
                            first?.inbox.id ?? "",
                        ]);
                        expect(first?.row).toMatchObject({ notifications: 1, lastBatch: "A" });
                    }),
                },
                {
                    name: "A_DEDUPED",
                    run: () => Effect.gen(function* () {
                        expect(yield* failure(evaluate(fire(1, 1, "poll-1", "A", 1000)))).toMatchObject({ _tag: "AlarmRefused" });
                        expect(yield* failure(evaluate(fire(1, 1, "poll-2", "A", 1060)))).toMatchObject({ _tag: "AlarmRefused" });
                        expect(yield* failure(evaluate(fire(1, 0, "poll-3", "B", 1060)))).toMatchObject({ _tag: "AlarmRefused" });
                    }),
                },
                {
                    name: "A_B",
                    run: () => Effect.gen(function* () {
                        expect((yield* evaluate(fire(1, 1, "poll-3", "B", 1060))).row).toMatchObject({
                            notifications: 2,
                            lastBatch: "B",
                            status: "armed",
                        });
                    }),
                },
                {
                    name: "A_PAUSED",
                    run: () => Effect.gen(function* () {
                        const paused = yield* evaluate(fire(1, 1, "poll-4", "C", 1070));
                        expect(paused?.row.status).toBe("paused");
                        expect(paused?.receipts.map((receipt: LedgerAction.Receipt) => receipt.action.kind)).toEqual([
                            "alarm.paused",
                            "prompt",
                        ]);
                        expect(yield* failure(evaluate(fire(1, 1, "poll-5", "D", 1070)))).toMatchObject({ _tag: "AlarmRefused" });
                        expect(alarms.due(2000).map((row: Alarm.Row) => row.id)).toEqual([]);
                    }),
                },
                {
                    name: "A_REARMED",
                    run: () => Effect.gen(function* () {
                        now = 1080;
                        const rearmed = (yield* alarms.rearm("A", "S", now));
                        expect(rearmed).toMatchObject({
                            status: "armed",
                            epoch: 2,
                            notifications: 0,
                            lastBatch: null,
                            fireAt: 1080,
                        });
                        expect((yield* Effect.exit(alarms.rearm("A", "other", now)))._tag).toBe("Failure");
                        expect(yield* failure(evaluate(fire(1, rearmed.fence, "poll-6", "A", 1080)))).toMatchObject({ _tag: "AlarmRefused" });
                    }),
                },
                {
                    name: "A_TAKEN",
                    run: () => Effect.gen(function* () {
                        const fence = alarms.get("A")?.fence ?? -1;
                        const taken = (yield* alarms.acquire("A", fence));
                        expect(taken?.fence).toBe(fence + 1);
                        expect(yield* failure(evaluate(fire(2, fence, "poll-7", "A", 1080)))).toMatchObject({ _tag: "AlarmRefused" });
                        expect((yield* evaluate(fire(2, fence + 1, "poll-7", "A", 1080))).row).toMatchObject({
                            epoch: 2,
                            notifications: 1,
                        });
                    }),
                },
                {
                    name: "ALARM_CANCELLED",
                    run: () => Effect.gen(function* () {
                        const fence = alarms.get("A")?.fence ?? -1;
                        expect((yield* alarms.cancel("A", "S", 1090))?.status).toBe("cancelled");
                        expect(yield* failure(evaluate(fire(2, fence, "poll-8", "B", 1090)))).toMatchObject({ _tag: "AlarmRefused" });
                        expect((yield* Effect.exit(alarms.rearm("A", "S", 1090)))._tag).toBe("Failure");
                        expect((yield* Effect.exit(alarms.acquire("A", fence + 1)))._tag).toBe("Failure");
                    }),
                },
            ],
        })));
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
        expect(final?.inbox.map((row: Inbox.Row) => [row.kind, row.status, row.content])).toEqual([
            ["prompt", "pending", "A"],
            ["prompt", "pending", "B"],
            ["prompt", "pending", expect.stringContaining("wake_budget")],
            ["prompt", "pending", "A"],
        ]);
        expect(new Set(final?.inbox.map((row: Inbox.Row) => row.id)).size).toBe(4);
        expect(evaluations).toBe(4);
        // Read through the reopened image: the alarm row survives replay unchanged.
        expect(Storage.get().alarms?.get("A")).toMatchObject({ status: "cancelled", epoch: 2 });
    })));
    test("lifecycle v1 product totality and effect-free prefix replay", () => traceTest(() => Effect.gen(function* () {
        const runtime = runtimeFor();
        const port = createSessionRequests(runtime);
        // Inbox ids are store-wide: a delivered reply keeps its input id, so each
        // session's contenders carry session-scoped input ids.
        const contenders = {
            answer: (q: SessionTransition.Request) => port.answer(reply(q, `${q.sessionId}:reply-1`, 1099)),
            refuse: (q: SessionTransition.Request) => port.answer({ ...reply(q, `${q.sessionId}:refuse-1`, 1099), decision: "refuse" }),
            cancel: (q: SessionTransition.Request) => cancelRequest(q, runtime),
            timeout: (q: SessionTransition.Request) => port.timeout(q.requestId, 1100).pipe(Effect.map(() => SessionHandleStore.requestById(q.requestId)?.state ?? "missing")),
        } as const;
        const names = Object.keys(contenders) as (keyof typeof contenders)[];
        const pairs = names.flatMap((first: keyof typeof contenders) => names.filter((second: keyof typeof contenders) => second !== first).map((second: keyof typeof contenders) => [first, second] as const));
        const opened = new Map<string, SessionTransition.Request>();
        const sessions = pairs.map(([first, second]: readonly [keyof typeof contenders, keyof typeof contenders]) => `${first}-${second}`);
        const result = (yield* toEffect(runLifecycleTrace({
            sessions: [...sessions, "STALE"],
            dispatched: () => 0,
            steps: [
                {
                    name: "QOPEN",
                    run: () => Effect.gen(function* () {
                        for (const id of [...sessions, "STALE"]) {
                            (yield* seedRequestSession(id));
                            opened.set(id, (yield* openRequest(port, id)));
                        }
                    }),
                },
                {
                    name: "PRODUCT",
                    run: () => Effect.gen(function* () {
                        for (const [first, second] of pairs) {
                            const q = requestOf(opened, `${first}-${second}`);
                            (yield* toEffect(contenders[first](q)));
                            const winner = SessionHandleStore.requestById(q.requestId);
                            const before = SessionHandleStore.tree(q.sessionId).length;
                            const loser = (yield* toEffect(contenders[second](q)));
                            expect(SessionHandleStore.requestById(q.requestId)).toMatchObject({
                                state: winner?.state,
                                outcome: winner?.outcome,
                                replies: winner?.replies,
                            });
                            expect(SessionHandleStore.tree(q.sessionId).length).toBeLessThanOrEqual(before + 1);
                            expect(["duplicate", "late_unknown", winner?.state]).toContain(loser);
                        }
                    }),
                },
                {
                    name: "CORRUPT",
                    run: () => Effect.gen(function* () {
                        const q = requestOf(opened, "STALE");
                        const fresh = SessionHandleStore.row(q.sessionId);
                        const corruptCommit = SessionHandleStore.commitRequestTransition({
                            sessionId: q.sessionId,
                            owner: "stranger",
                            fence: fresh.leaseFence,
                            now: 1099,
                            expectedRevision: fresh.revision,
                            actions: [],
                            consumeInboxIds: [],
                            state: fresh.state,
                            releaseLease: false,
                        });
                        expect((yield* Effect.exit(corruptCommit))._tag).toBe("Failure");
                        expect((yield* toEffect(port.answer({ ...reply(q, "corrupt-binding", 1099), bindingDigest: "forged" })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({ ...reply(q, "corrupt-generation", 1099), generation: 9 })))).toBe("rejected");
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "corrupt-effect", 1099),
                            effectHash: canonicalDigest({}),
                        })))).toBe("rejected");
                        // Misrouted to a real session: refused there before any record, and
                        // never applied here. The destination row does not move at all.
                        const destination = SessionHandleStore.row("answer-refuse");
                        const destinationTree = SessionHandleStore.tree("answer-refuse").length;
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "corrupt-session", 1099),
                            sessionId: "answer-refuse",
                        })))).toBe("rejected");
                        expect(SessionHandleStore.row("answer-refuse").revision).toBe(destination.revision);
                        expect(SessionHandleStore.tree("answer-refuse")).toHaveLength(destinationTree);
                        expect(SessionHandleStore.requestById("answer-refuse:q")?.seenReplyIds).toEqual([
                            "answer-refuse:reply-1",
                            "answer-refuse:refuse-1",
                        ]);
                        expect((yield* failure(port.answer({ ...reply(q, "corrupt-missing", 1099), sessionId: "OTHER" })))).toBeInstanceOf(Error);
                        expect(SessionHandleStore.requestById(q.requestId)?.state).toBe("open");
                        expect((yield* toEffect(port.answer(reply(q, "STALE:reply-1", 1099))))).toBe("resolved");
                        // The winning input id replayed by a different principal is a
                        // conflicting replay: refused without a record, the winner untouched.
                        const settled = SessionHandleStore.tree(q.sessionId).length;
                        expect((yield* toEffect(port.answer({
                            ...reply(q, "STALE:reply-1", 1099),
                            principal: { kind: "session", principalId: "impostor", evidenceId: "other" },
                        })))).toBe("rejected");
                        expect(SessionHandleStore.tree(q.sessionId)).toHaveLength(settled);
                        expect(SessionHandleStore.requestById(q.requestId)?.replies.map((r: SessionTransition.Request["replies"][number]) => r.responderId)).toEqual(["worker"]);
                    }),
                },
            ],
        })));
        // Terminal uniqueness: exactly one `<requestId>:resolution` record per
        // session; the losing contender is exactly one duplicate record. No product
        // session ever holds a `rejected` record: only STALE is probed with
        // corrupt input, and a misrouted answer leaves nothing behind.
        for (const id of sessions) {
            const final = result.final.get(id);
            const records = resolutions(final);
            expect(records[0]).toEqual(["request", "opened"]);
            expect(final?.actions.filter((action: LedgerAction.Node) => action.id === `${id}:q:resolution`)).toHaveLength(1);
            expect(records.filter(([, resolution]: ReturnType<typeof resolutions>[number]) => resolution === "duplicate")).toHaveLength(1);
            expect(records.filter(([, resolution]: ReturnType<typeof resolutions>[number]) => !["opened", "duplicate", undefined].includes(resolution as string))).toHaveLength(2);
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
        const misrouted = [...result.final.values()].flatMap((snapshot: SessionSnapshot) => snapshot.actions.filter((action: LedgerAction.Node) => action.id.includes("corrupt-session")));
        expect(misrouted).toEqual([]);
        expect(resolutions(result.final.get("answer-refuse")).at(-1)).toEqual(["reply", "duplicate"]);
    })));
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
    expect(late?.actions.slice(4).map((action: LedgerAction.Node) => objectValue(action.effect.value)?.resolution)).toEqual(["opened", "late_unknown", "late_unknown", "duplicate"]);
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
        replies: [{ replyId: "reply-1", responderId: "worker", content: "ok", receivedAt: 1099 }],
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
    expect(answered?.inbox.map((row: Inbox.Row) => [row.id, row.kind, row.status])).toEqual([
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
    if (snapshot === undefined)
        throw new Error(`no ${sessionId} snapshot after ${step}`);
    return snapshot;
}
/** 6.4 child/parent loss boundary: the reply is delivered once across two recoveries. */
function assertLossBoundary(result: TraceResult, parentChild: ReturnType<typeof childParentFixture>): void {
    expect(named(result, "CP_SEALED", "CHILD").outbound).toMatchObject([
        { state: "pending", destinationReceipt: null },
    ]);
    expect(named(result, "CP_SEALED", "PARENT").inbox).toEqual([]);
    expect(named(result, "CP_RECEIVED", "CHILD").outbound.map((row: SessionTransition.Outbound) => row.state)).toEqual([
        "pending",
    ]);
    const receivedParent = named(result, "CP_RECEIVED", "PARENT");
    expect(receivedParent.inbox).toHaveLength(1);
    const ackedParent = named(result, "CP_ACKED", "PARENT");
    expect(ackedParent.actions).toEqual(receivedParent.actions);
    const [delivered] = named(result, "CP_ACKED", "CHILD").outbound;
    if (delivered === undefined)
        throw new Error("child lost its outbound obligation");
    expect(delivered).toMatchObject({
        state: "delivered",
        message: { replyTo: "mCR", destinationSessionId: "PARENT", terminal: "completed" },
    });
    expect(delivered.destinationReceipt?.id).toBe(delivered.message.messageId);
    expect(ackedParent.inbox.map((row: Inbox.Row) => row.id)).toEqual([delivered.message.messageId]);
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
    if (request === undefined)
        throw new Error(`no request for ${id}`);
    return request;
}
/**
 * An Owner cancel issued from outside a live handle: a fresh fenced lease around
 * the shared request commit, exactly like the gateway port's own transition.
 */
function cancelRequest(q: SessionTransition.Request, runtime: SessionRuntime) {
    return Effect.gen(function* () {
        const controller = `conformance:control:${++nextId}`;
        const row = SessionHandleStore.row(q.sessionId);
        const lease = (yield* SessionHandleStore.acquireLease({
            sessionId: q.sessionId,
            owner: controller,
            expectedFence: row.leaseFence,
            now,
            expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
        }));
        try {
            return (yield* commitSessionRequest(q.sessionId, { owner: controller, fence: lease.fence }, { kind: "request.cancel", requestId: q.requestId, principal: owner }, `cancel-1:${q.sessionId}`, 1099, runtime)).resolution;
        }
        finally {
            const current = SessionHandleStore.row(q.sessionId);
            (yield* SessionHandleStore.commit({
                sessionId: q.sessionId,
                owner: controller,
                fence: lease.fence,
                now,
                expectedRevision: current.revision,
                actions: [],
                consumeInboxIds: [],
                state: current.state,
                releaseLease: true,
            }));
        }
    });
}
function reply(q: SessionTransition.Request, inputId: string, receivedAt: number): SessionTransition.Answer {
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
/** The pending turn every 6.x seed opens under its `cfg` boundary at the given generation. */
function pendingTurn(sessionId: string, turnId: string, boundaryActionId: string, resultId: string, generation: ReturnType<typeof SessionHandleStore.latestGeneration>): LedgerAction.Append {
    return {
        id: turnId,
        sessionId,
        parentId: boundaryActionId,
        kind: "turn",
        intent: {
            encodingVersion: 1,
            value: {
                phase: "intent",
                resultId,
                inboxIds: [],
                resumeCount: 0,
                boundaryActionId,
                toolsGeneration: generation.generation,
                toolsHash: generation.toolsHash,
                systemHash: generation.systemHash,
                policyGeneration: 1,
            },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: now,
        irreversible: true,
    };
}
/** A fresh resident at G1 whose lease `owner` holds for `leaseMs`: the seed every request fixture starts from. */
function seedLeasedResident(id: string, actionId: string, owner: string, leaseMs: number) {
    return Effect.gen(function* () {
        const created = (yield* SessionHandleStore.materialize({
            id,
            parentId: null,
            role: "resident",
            tools: [],
            system: { preset: "", blocks: [] },
            policyGeneration: 1,
            actionId,
            at: now,
        }));
        const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(id));
        const lease = (yield* SessionHandleStore.acquireLease({
            sessionId: id,
            owner,
            expectedFence: created.row.leaseFence,
            now,
            expiresAt: now + leaseMs,
        }));
        if (!lease.ok)
            throw new Error(`${owner} lease refused`);
        return { created, generation, lease };
    });
}
/** The immutable request prefix of 6.4: cfg, T, q-pre, q (a real tool intent with value {value:"B"}). */
function seedRequestSession(id: string) {
    return Effect.gen(function* () {
        const { created, generation, lease } = (yield* seedLeasedResident(id, `${id}:cfg`, "o", 30000));
        const turn = `${id}:T`;
        const _committed = (yield* SessionHandleStore.commit({
            sessionId: id,
            owner: "o",
            fence: lease.fence,
            now,
            expectedRevision: created.row.revision,
            consumeInboxIds: [],
            state: "running",
            releaseLease: true,
            actions: [
                pendingTurn(id, turn, `${id}:cfg`, `${id}:R`, generation),
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
        }));
    });
}
function openRequest(port: ReturnType<typeof createSessionRequests>, id: string) {
    return Effect.gen(function* () {
        const request = yield* port.open({
            requestId: `${id}:q`,
            sessionId: id,
            expectedResponders: ["worker"],
            correlation: { channelId: "ch", replyToMessageId: "platform-1" },
            allowedActions: ["report_result"],
            resolution: "first",
            threshold: 1,
            deadline: 1100,
            at: now,
        });
        expect(request.state).toBe("open");
        return request;
    });
}
/** Crash-open seed of 6.2: dead owner, T pinned to G1 while the row already points at G2. */
function seedCrashOpen(id: string) {
    return Effect.gen(function* () {
        const { created, generation, lease } = (yield* seedLeasedResident(id, "cfg", "dead", 10));
        const g2 = SessionHandleStore.generationSnapshot({
            generation: generation.generation + 1,
            revertTo: generation.generation,
            tools: [],
            system: { preset: "", blocks: [{ id: "b", source: "fixture", content: "v2" }] },
            policyGeneration: 1,
        });
        const _committed = (yield* SessionHandleStore.commit({
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
                pendingTurn(id, "T", "cfg", "R", generation),
                SessionHandleStore.configureAction({
                    id: "cfg2",
                    sessionId: id,
                    parentId: "T",
                    operation: "system.blocks.set",
                    snapshot: g2,
                    at: now + 1,
                }),
            ],
        }));
    });
}
/** Child/parent loss boundary of 6.4 on two real session histories and the real outbound path. */
function childParentFixture() {
    const sent: string[] = [];
    let consumed = 0;
    const parentRunner: SessionRunner = () => Effect.sync(() => {
        consumed += 1;
        return { kind: "result", text: "received" };
    });
    function runtime(loseAck: boolean, dispatch: boolean, scope: Scope.Scope): SessionRuntime {
        const value = runtimeFor({
            dispatchOutbound({ message }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) {
                return Effect.gen(function* () {
                    if (!dispatch)
                        throw new Error("process died before wake");
                    sent.push(JSON.stringify(message));
                    const received = (yield* receiveOutbound(message, now));
                    yield* wakeSession(message.destinationSessionId, parentRunner, value).pipe(
                        Effect.provideService(Scope.Scope, scope),
                        Effect.mapError((error: SessionError) => new ForeignFailure({ operation: "wakeSession", cause: error.message })),
                    );
                    if (loseAck)
                        throw new Error("source ack lost");
                    return received.receipt;
                });
            },
        });
        return value;
    }
    return {
        sent: () => sent,
        consumed: () => consumed,
        sealWithoutWake() {
            return Effect.scoped(Effect.gen(function* () {
                const first = runtime(false, false, yield* Effect.scope);
                (yield* session({ id: "PARENT", role: "resident", runner: parentRunner }, first));
                const child = (yield* session({
                    id: "CHILD",
                    parentId: "PARENT",
                    role: "worker",
                    runner: () => Effect.succeed({ kind: "result" as const, text: "done" }),
                }, first));
                // The parent's real source action: the reply observation resolves it.
                const source = SessionHandleStore.tree("PARENT")[0]?.id;
                if (source === undefined)
                    throw new Error("parent has no source action");
                expect((yield* failure(child.prompt("hello", {
                    encodingVersion: 1,
                    value: {
                        kind: "message",
                        messageId: "mCR",
                        senderSessionId: "PARENT",
                        sourceActionId: source,
                    },
                })))).toBeInstanceOf(Error);
                // Process loss closes fiber ownership, not the graceful session
                // API, which would append a new interrupt to the parent inbox.
                runtimes.splice(runtimes.indexOf(first), 1);
            }));
        },
        recoverLosingAck() {
            return Effect.scoped(Effect.gen(function* () {
                now = 2000;
                const second = runtime(true, true, yield* Effect.scope);
                expect((yield* failure(sweepSessions((row: LedgerSession.Row) => (row.id === "PARENT" ? parentRunner : rejectReplay), second)))).toBeInstanceOf(Error);
                runtimes.splice(runtimes.indexOf(second), 1);
            }));
        },
        recoverAndAck() {
            return Effect.gen(function* () {
                now = 33000;
                const third = runtime(false, true, yield* Effect.scope);
                (yield* toEffect(sweepSessions((row: LedgerSession.Row) => (row.id === "PARENT" ? parentRunner : rejectReplay), third)));
                (yield* toEffect(closeSessions(third)));
                runtimes.splice(runtimes.indexOf(third), 1);
            });
        },
    };
}
const rejectReplay: SessionRunner = () => Effect.die(new Error("sealed child replayed"));

function toEffect<A, E = never, R = never>(value: Effect.Effect<A, E, R> | Promise<A> | A): Effect.Effect<A, E, R> {
 return Effect.isEffect(value) ? value : value instanceof Promise ? Effect.promise(() => value) : Effect.succeed(value);
}
function waitFor<A, E = never>(value: Promise<A> | Fiber.RuntimeFiber<A, E> | Effect.Effect<A, E, Scope.Scope>, label: string): Effect.Effect<A, E | Error, Scope.Scope> {
 const program = value instanceof Promise ? Effect.promise(() => value) : "await" in value ? Fiber.join(value) : value;
 return program.pipe(Effect.timeoutFail({duration: SIGNAL_TIMEOUT_MS, onTimeout: () => new Error(label)}));
}
function traceTest(body: () => Effect.Effect<void, SessionError | Error, Scope.Scope>) {
 return isolated(Effect.scoped(Effect.gen(function* () {
 now = 1_000; nextId = 0; sink = new TraceSink();
 directory = mkdtempSync(join(tmpdir(), "lifecycle-conformance-")); dbPath = join(directory, "ledger.sqlite");
 Storage.reset(); Storage.initialize({dbPath, observationSink: sink}); seedPolicy();
 try { yield* body(); } finally {
 for (const runtime of runtimes.splice(0)) yield* closeSessions(runtime);
 Storage.reset(); rmSync(directory, {recursive: true, force: true});
 }
 })));
}
