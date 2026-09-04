import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSessions,
  session,
  SessionCommitError,
  type SessionCreateOptions,
  type SessionRunner,
  type SessionRunnerInput,
  type SessionRuntime,
  sweepSessions,
} from "../src/session-handle";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  type BusEvent,
  L0Observation,
  type ObservationSink,
  type SessionGeneration,
  type SessionTurn,
} from "@openomni/protocol";
import { Bus } from "../src/index";

const SIGNAL_TIMEOUT_MS = 1_000;

interface Signal<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function signal<T>(): Signal<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      SIGNAL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class TestObservationSink implements ObservationSink {
  dropNextCommit = false;
  onCommit: ((committed: L0Observation.ActionCommitted) => void) | undefined;

  publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    if (event.name === L0Observation.ActionCommittedEvent.name) {
      if (this.dropNextCommit) {
        this.dropNextCommit = false;
        return;
      }
      this.onCommit?.(L0Observation.ActionCommittedEvent.schema.parse(data));
    }
    Bus.publish(event, data);
  }

  subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void {
    return Bus.subscribe(event, handler, options);
  }
}

const tool = (name: string): SessionGeneration.Tool => ({
  name,
  category: "query",
  inputSchema: { type: "object", properties: {} },
});

const system = {
  preset: "resident preset",
  blocks: [{ id: "rules", source: "test", content: "Stay deterministic." }],
} as const;

let now = 1_000;
let nextId = 0;
let sink: TestObservationSink;
let runtime: SessionRuntime;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  now = 1_000;
  nextId = 0;
  sink = new TestObservationSink();
  runtime = {
    observations: sink,
    clock: () => now,
    entropy: () => `session-test-id-${++nextId}`,
    processId: "session-test-process",
    scheduleHeartbeat: () => () => undefined,
  };
  Storage.initialize({ dbPath: ":memory:", observationSink: sink });
});

afterEach(async () => {
  await closeSessions(runtime);
  Storage.reset();
  Bus.reset();
});

function residentOptions(id: string, runner: SessionRunner): SessionCreateOptions {
  return { id, role: "resident", runner, tools: [tool("read")], system };
}

function commitOpenTurn(input: {
  readonly sessionId: string;
  readonly resultId: string;
  readonly resumeCount: number;
}): void {
  const created = SessionHandleStore.materialize({
    id: input.sessionId,
    parentId: null,
    role: "resident",
    tools: [tool("read")],
    system,
    policyGeneration: 0,
    actionId: `${input.sessionId}:configure`,
    at: now,
  });
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(input.sessionId));
  const acquired = SessionHandleStore.acquireLease({
    sessionId: input.sessionId,
    owner: "crashed-owner",
    expectedFence: created.row.leaseFence,
    now,
    expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
  });
  if (!acquired.ok) throw new Error("crash fixture could not acquire its lease");
  const committed = SessionHandleStore.commit({
    sessionId: input.sessionId,
    owner: "crashed-owner",
    fence: acquired.fence,
    now,
    expectedRevision: created.row.revision,
    actions: [
      {
        id: `${input.sessionId}:turn`,
        parentId: SessionHandleStore.tree(input.sessionId).at(-1)?.id ?? null,
        sessionId: input.sessionId,
        kind: "turn",
        intent: {
          encodingVersion: 1,
          value: {
            phase: "intent",
            resultId: input.resultId,
            inboxIds: [],
            toolsGeneration: generation.generation,
            toolsHash: generation.toolsHash,
            systemHash: generation.systemHash,
            policyGeneration: generation.policyGeneration,
            resumeCount: input.resumeCount,
            boundaryActionId: null,
          },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        irreversible: true,
        ts: now,
      },
    ],
    consumeInboxIds: [],
    state: "running",
    releaseLease: false,
  });
  if (!committed.ok) throw new Error("crash fixture could not commit its open turn");
  now += SessionHandleStore.LEASE_TTL_MS;
}

describe("durable session handle", () => {
  test("serializes one runner and drains concurrent prompts as distinct ordered messages", async () => {
    const entered = signal<SessionRunnerInput>();
    const releaseBoundary = signal<void>();
    let active = 0;
    let maximumActive = 0;
    let runs = 0;
    const drained: SessionTurn.Message[][] = [];
    const runner: SessionRunner = async (input) => {
      const treeAtEntry = SessionHandleStore.tree(input.sessionId);
      const intent = treeAtEntry.find((action) => action.id === input.turnId);
      expect(SessionHandleStore.turnIntent(intent)?.resultId).toBe(input.resultId);
      expect(treeAtEntry.some((action) => action.id === input.resultId)).toBe(false);
      runs += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered.resolve(input);
      await releaseBoundary.promise;
      drained.push([...(await input.boundary("after_llm")).messages]);
      active -= 1;
      return { kind: "result", text: "done" };
    };
    const handle = session(residentOptions("single-flight", runner), runtime);

    const first = handle.prompt("first prompt");
    const firstInput = await bounded(entered.promise, "runner entry");
    const second = handle.prompt("second prompt");
    const third = handle.prompt("third prompt");
    releaseBoundary.resolve();
    await bounded(Promise.all([first, second, third]), "serialized prompt completion");

    expect(runs).toBe(1);
    expect(maximumActive).toBe(1);
    expect(firstInput.messages).toEqual([{ role: "user", text: "first prompt" }]);
    expect(drained).toEqual([
      [
        { role: "user", text: "second prompt" },
        { role: "user", text: "third prompt" },
      ],
    ]);
    expect(SessionHandleStore.inboxRows(handle.id).map((row) => [row.content, row.status])).toEqual(
      [
        ["first prompt", "consumed"],
        ["second prompt", "consumed"],
        ["third prompt", "consumed"],
      ],
    );
    expect(
      SessionHandleStore.tree(handle.id)
        .map(SessionHandleStore.delivery)
        .filter((delivery): delivery is SessionTurn.Delivery => delivery !== undefined)
        .map((delivery) => delivery.inboxId),
    ).toEqual(SessionHandleStore.inboxRows(handle.id).map((row) => row.id));
  });

  test("records an idle interrupt as a no-op without resuming the next prompt", async () => {
    const inputs: SessionRunnerInput[] = [];
    const runner: SessionRunner = async (input) => {
      inputs.push(input);
      return { kind: "result", text: "ran once" };
    };
    const handle = session(residentOptions("idle-interrupt", runner), runtime);
    SessionHandleStore.commitInbox({
      id: "idle-interrupt:interrupt",
      sessionId: handle.id,
      kind: "interrupt",
      content: "",
      origin: { encodingVersion: 1, value: { source: "test" } },
      createdAt: now,
      parentActionId: SessionHandleStore.tree(handle.id).at(-1)?.id ?? null,
    });

    const result = await handle.prompt("run after the no-op");

    expect(result).toEqual({ kind: "result", text: "ran once" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.resumeCount).toBe(0);
    expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
    expect(
      SessionHandleStore.tree(handle.id).filter(
        (action) => SessionHandleStore.turnResume(action) !== undefined,
      ),
    ).toEqual([]);
  });

  test("seals a queued prompt followed by an interrupt without entering the runner", async () => {
    let entries = 0;
    const runner: SessionRunner = async () => {
      entries += 1;
      return { kind: "result", text: "must not run" };
    };
    const handle = session(residentOptions("queued-interrupt", runner), runtime);
    const parentActionId = SessionHandleStore.tree(handle.id).at(-1)?.id ?? null;
    SessionHandleStore.commitInbox({
      id: "queued-interrupt:prompt",
      sessionId: handle.id,
      kind: "prompt",
      content: "do not run",
      origin: { encodingVersion: 1, value: { source: "test" } },
      createdAt: now,
      parentActionId,
    });
    SessionHandleStore.commitInbox({
      id: "queued-interrupt:interrupt",
      sessionId: handle.id,
      kind: "interrupt",
      content: "",
      origin: { encodingVersion: 1, value: { source: "test" } },
      createdAt: now + 1,
      parentActionId,
    });

    await sweepSessions(() => runner, runtime);

    expect(entries).toBe(0);
    expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
    expect(handle.get()).toMatchObject({
      state: "interrupted",
      turns: [{ terminal: { kind: "interrupted" } }],
    });
  });

  test("a leading idle interrupt is consumed before a later prompt starts", async () => {
    const inputs: SessionRunnerInput[] = [];
    const runner: SessionRunner = async (input) => {
      inputs.push(input);
      return { kind: "result", text: "ran once" };
    };
    const handle = session(residentOptions("leading-idle-interrupt", runner), runtime);
    const parentActionId = SessionHandleStore.tree(handle.id).at(-1)?.id ?? null;
    SessionHandleStore.commitInbox({
      id: "leading-idle-interrupt:interrupt",
      sessionId: handle.id,
      kind: "interrupt",
      content: "",
      origin: { encodingVersion: 1, value: { source: "test" } },
      createdAt: now,
      parentActionId,
    });
    SessionHandleStore.commitInbox({
      id: "leading-idle-interrupt:prompt",
      sessionId: handle.id,
      kind: "prompt",
      content: "run afterward",
      origin: { encodingVersion: 1, value: { source: "test" } },
      createdAt: now + 1,
      parentActionId,
    });

    await sweepSessions(() => runner, runtime);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.resumeCount).toBe(0);
    expect(inputs[0]?.messages).toEqual([{ role: "user", text: "run afterward" }]);
  });

  test("consumes a running interrupt and seals interrupted rather than error", async () => {
    const ready = signal<AbortSignal>();
    const aborted = signal<void>();
    const runner: SessionRunner = async (input) => {
      input.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      ready.resolve(input.signal);
      await aborted.promise;
      return { kind: "result", text: "late result must not commit" };
    };
    const handle = session(residentOptions("interrupt", runner), runtime);

    const running = handle.prompt("start");
    const runnerSignal = await bounded(ready.promise, "interrupt listener installation");
    const interrupted = handle.interrupt();
    await bounded(aborted.promise, "runner abort");
    await bounded(Promise.all([running, interrupted]), "interrupted terminal");

    expect(runnerSignal.aborted).toBe(true);
    expect(SessionHandleStore.inboxRows(handle.id).map((row) => row.status)).toEqual([
      "consumed",
      "consumed",
    ]);
    const terminals = SessionHandleStore.tree(handle.id)
      .map(SessionHandleStore.turnTerminal)
      .filter((terminal): terminal is SessionTurn.Terminal => terminal !== undefined);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind).toBe("interrupted");
    expect(handle.get().state).toBe("interrupted");
  });

  test("does not overlap a resumed runner when the interrupted runner ignores abort", async () => {
    const firstEntered = signal<void>();
    const firstAborted = signal<void>();
    const releaseFirst = signal<void>();
    let entries = 0;
    let active = 0;
    let maximumActive = 0;
    const runner: SessionRunner = async (input) => {
      entries += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (entries === 1) {
        input.signal.addEventListener("abort", () => firstAborted.resolve(), { once: true });
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      active -= 1;
      return { kind: "result", text: `run ${entries}` };
    };
    const handle = session(residentOptions("non-cooperative-interrupt", runner), runtime);

    const first = handle.prompt("start");
    await bounded(firstEntered.promise, "first runner entry");
    const interrupted = handle.interrupt();
    await bounded(firstAborted.promise, "first runner abort signal");
    const resumed = handle.resume();
    expect(entries).toBe(1);
    expect(maximumActive).toBe(1);
    releaseFirst.resolve();
    await bounded(Promise.all([first, interrupted, resumed]), "serialized resume completion");

    expect(entries).toBe(2);
    expect(maximumActive).toBe(1);
  });

  test("keeps the durable lease held through an ignored abort so no other runtime can resume", async () => {
    const entered = signal<void>();
    const abortSeen = signal<void>();
    const releaseRunner = signal<void>();
    const hibernated = signal<void>();
    let active = 0;
    let maximumActive = 0;
    const runner: SessionRunner = async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      input.signal.addEventListener("abort", () => abortSeen.resolve(), { once: true });
      entered.resolve();
      await releaseRunner.promise;
      active -= 1;
      return { kind: "result", text: "late" };
    };
    const handle = session(residentOptions("lease-held-through-abort", runner), {
      ...runtime,
      onHibernate: () => hibernated.resolve(),
    });

    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    const interrupted = handle.interrupt();
    await bounded(abortSeen.promise, "runner abort signal");

    // The interrupted terminal is sealed promptly, but the runner ignored the
    // abort and is still alive, so the durable lease MUST stay held by this
    // owner. A second runtime/process acquiring it without waiting for the TTL
    // (no clock advance) must be refused, or two live executors could exist for
    // one durable session.
    expect(handle.get().state).toBe("interrupted");
    const contended = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence: handle.get().lease.fence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(contended.ok).toBe(false);
    expect(maximumActive).toBe(1);

    // Once the runner settles, this owner releases the lease and it becomes
    // acquirable again.
    // The caller-facing interrupt completes at the sealed terminal, not when
    // the abort-ignoring runner finally settles.
    await bounded(interrupted, "interrupt receipt before runner settlement");
    expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();
    releaseRunner.resolve();
    await bounded(Promise.all([running, hibernated.promise]), "runner settlement + lease release");
    const afterSettle = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence: handle.get().lease.fence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(afterSettle.ok).toBe(true);
    expect(maximumActive).toBe(1);
  });

  test("a retained runner whose lease lapsed does not wedge the handle: the next prompt still runs", async () => {
    const entered = signal<void>();
    const abortSeen = signal<void>();
    const releaseRunner = signal<void>();
    const hibernated = signal<void>();
    let calls = 0;
    const runner: SessionRunner = async (input) => {
      calls += 1;
      if (calls > 1) return { kind: "result", text: "resumed" };
      input.signal.addEventListener("abort", () => abortSeen.resolve(), { once: true });
      entered.resolve();
      await releaseRunner.promise;
      return { kind: "result", text: "late" };
    };
    const handle = session(residentOptions("retained-lease-lapsed", runner), {
      ...runtime,
      onHibernate: () => hibernated.resolve(),
    });

    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    const interrupted = handle.interrupt();
    await bounded(abortSeen.promise, "runner abort signal");
    await bounded(interrupted, "interrupt receipt");

    // The runner outlives its TTL (contract violation) and the lease lapses
    // before it settles. The retained release must treat the lapsed lease as
    // nothing-to-release instead of failing a stale commit and wedging every
    // later turn start behind the detached settlement.
    now += SessionHandleStore.LEASE_TTL_MS;
    releaseRunner.resolve();
    await bounded(Promise.all([running, hibernated.promise]), "retained settlement");

    const leaseBefore = SessionHandleStore.row(handle.id).leaseFence;
    await bounded(handle.resume(), "resume after retained settlement");
    expect(calls).toBe(2);
    expect(handle.get().state).toBe("idle");
    expect(SessionHandleStore.row(handle.id).leaseFence).toBe(leaseBefore + 1);
  });

  test("configure during the ignored-abort window keeps the lease held by the live runner", async () => {
    const entered = signal<void>();
    const abortSeen = signal<void>();
    const releaseRunner = signal<void>();
    const hibernated = signal<void>();
    let active = 0;
    let maximumActive = 0;
    const runner: SessionRunner = async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      input.signal.addEventListener("abort", () => abortSeen.resolve(), { once: true });
      entered.resolve();
      await releaseRunner.promise;
      active -= 1;
      return { kind: "result", text: "late" };
    };
    const handle = session(residentOptions("configure-in-interrupt-window", runner), {
      ...runtime,
      onHibernate: () => hibernated.resolve(),
    });

    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    const interrupted = handle.interrupt();
    await bounded(abortSeen.promise, "runner abort signal");
    expect(handle.get().state).toBe("interrupted");
    const fenceBefore = handle.get().lease.fence;

    // A configure while the abort-ignoring runner is still alive must neither
    // rotate the fence nor release the lease: the live executor still owns it.
    const receipt = await bounded(handle.tools.add([tool("search")]), "configure receipt");
    expect(receipt.generation).toBeGreaterThan(0);
    const afterConfigure = handle.get();
    expect(afterConfigure.lease.fence).toBe(fenceBefore);
    expect(afterConfigure.lease.owner).not.toBeNull();
    const contended = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence: afterConfigure.lease.fence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(contended.ok).toBe(false);
    expect(maximumActive).toBe(1);

    // The caller-facing interrupt completes at the sealed terminal, not when
    // the abort-ignoring runner finally settles.
    await bounded(interrupted, "interrupt receipt before runner settlement");
    expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();
    releaseRunner.resolve();
    await bounded(Promise.all([running, hibernated.promise]), "runner settlement + lease release");
    const afterSettle = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence: handle.get().lease.fence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(afterSettle.ok).toBe(true);
    expect(maximumActive).toBe(1);
  });

  test("configure re-entered from the interrupted seal observation still sees the lease as held", async () => {
    const entered = signal<void>();
    const releaseRunner = signal<void>();
    const hibernated = signal<void>();
    let active = 0;
    let maximumActive = 0;
    const runner: SessionRunner = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered.resolve();
      await releaseRunner.promise;
      active -= 1;
      return { kind: "result", text: "late" };
    };
    const handle = session(residentOptions("configure-from-seal-observation", runner), {
      ...runtime,
      onHibernate: () => hibernated.resolve(),
    });
    // Re-enter configure synchronously from the observation of the interrupted
    // terminal seal — the earliest point a subscriber can react to it.
    const reentered = signal<() => Promise<SessionGeneration.ConfigureReceipt>>();
    let fenceAtSeal = -1;
    sink.onCommit = (committed) => {
      if (committed.kind !== "turn" || fenceAtSeal !== -1) return;
      const row = SessionHandleStore.row(handle.id);
      if (row.state !== "interrupted") return;
      fenceAtSeal = row.leaseFence;
      const configured = handle.tools.add([tool("search")]);
      reentered.resolve(() => configured);
    };

    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    const interrupted = handle.interrupt();
    const reentrant = await bounded(reentered.promise, "seal observation");
    await bounded(reentrant(), "re-entrant configure");

    const row = SessionHandleStore.row(handle.id);
    expect(row.leaseFence).toBe(fenceAtSeal);
    expect(row.leaseOwner).not.toBeNull();
    const contended = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence: row.leaseFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(contended.ok).toBe(false);

    // The caller-facing interrupt completes at the sealed terminal, not when
    // the abort-ignoring runner finally settles.
    await bounded(interrupted, "interrupt receipt before runner settlement");
    expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();
    releaseRunner.resolve();
    await bounded(Promise.all([running, hibernated.promise]), "runner settlement + lease release");
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
    expect(maximumActive).toBe(1);
  });

  test("close() returns after the grace window while the lease stays held until the abort-ignoring runner settles", async () => {
    const entered = signal<void>();
    const releaseRunner = signal<void>();
    const hibernated = signal<void>();
    let active = 0;
    let maximumActive = 0;
    const runner: SessionRunner = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered.resolve();
      await releaseRunner.promise;
      active -= 1;
      return { kind: "result", text: "late" };
    };
    const handle = session(residentOptions("close-detaches-after-grace", runner), {
      ...runtime,
      closeGraceMs: 0,
      onHibernate: () => hibernated.resolve(),
    });

    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    await bounded(handle.close(), "close with zero grace");

    // Detached from the caller only: the lease is still held by this executor
    // and its heartbeat keeps renewing, so no second executor can start.
    const row = SessionHandleStore.row(handle.id);
    expect(row.leaseOwner).not.toBeNull();
    const whileAlive = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence: row.leaseFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(whileAlive.ok).toBe(false);

    // Once the runner settles the turn continuation releases the lease itself.
    releaseRunner.resolve();
    await bounded(Promise.all([running, hibernated.promise]), "runner settlement + lease release");
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
    const afterSettle = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence: SessionHandleStore.row(handle.id).leaseFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(afterSettle.ok).toBe(true);
    expect(maximumActive).toBe(1);
  });

  test("heartbeat loss aborts the runner and the stale fence cannot seal its result", async () => {
    const entered = signal<SessionRunnerInput>();
    const aborted = signal<void>();
    let heartbeat: (() => void) | undefined;
    runtime = {
      ...runtime,
      scheduleHeartbeat: (callback) => {
        heartbeat = callback;
        return () => undefined;
      },
    };
    const runner: SessionRunner = async (input) => {
      input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve(input);
      await aborted.promise;
      return { kind: "result", text: "stale completion" };
    };
    const handle = session(residentOptions("heartbeat-loss", runner), runtime);

    const running = handle.prompt("start");
    await bounded(entered.promise, "heartbeat runner entry");
    now += SessionHandleStore.LEASE_TTL_MS;
    const stolen = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "replacement-owner",
      expectedFence: handle.get().lease.fence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    expect(stolen.ok).toBe(true);
    if (heartbeat === undefined) throw new Error("heartbeat was not scheduled");
    heartbeat();

    await bounded(aborted.promise, "heartbeat abort");
    await expect(running).rejects.toBeInstanceOf(SessionCommitError);
    expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toHaveLength(1);
    expect(
      SessionHandleStore.tree(handle.id).some((action) => SessionHandleStore.turnTerminal(action)),
    ).toBe(false);
  });

  test("pins generation N while configure commits generation N+1", async () => {
    const firstEntered = signal<SessionRunnerInput>();
    const secondEntered = signal<SessionRunnerInput>();
    const releaseFirst = signal<void>();
    const inputs: SessionRunnerInput[] = [];
    const runner: SessionRunner = async (input) => {
      inputs.push(input);
      if (inputs.length === 1) {
        firstEntered.resolve(input);
        await releaseFirst.promise;
      } else {
        secondEntered.resolve(input);
      }
      return { kind: "result", text: `generation ${input.toolsGeneration}` };
    };
    const handle = session(residentOptions("configure-pinning", runner), runtime);

    const firstTurn = handle.prompt("turn one");
    const pinned = await bounded(firstEntered.promise, "generation N runner");
    const receipt = await handle.tools.add([tool("search")]);
    releaseFirst.resolve();
    await bounded(firstTurn, "generation N terminal");
    const secondTurn = handle.prompt("turn two");
    const next = await bounded(secondEntered.promise, "generation N+1 runner");
    await bounded(secondTurn, "generation N+1 terminal");

    expect(receipt).toEqual({ generation: 2, revertTo: 1 });
    expect(pinned.toolsGeneration).toBe(1);
    expect(pinned.tools.map((entry) => entry.name)).toEqual(["read"]);
    expect(next.toolsGeneration).toBe(2);
    expect(next.tools.map((entry) => entry.name)).toEqual(["read", "search"]);
    expect(next.systemHash).toBe(pinned.systemHash);
  });

  test("rejects an existing tool name before committing a configure action", async () => {
    const runner: SessionRunner = async () => ({ kind: "result", text: "unused" });
    const handle = session(residentOptions("duplicate-tool", runner), runtime);
    const before = handle.get();

    await expect(handle.tools.add([tool("read")])).rejects.toMatchObject({
      name: "SessionConfigureError",
      data: { code: "duplicate_tool" },
    });

    expect(handle.get()).toEqual(before);
    expect(
      SessionHandleStore.tree(handle.id).filter((action) => action.kind === "session.configure"),
    ).toHaveLength(1);
  });

  test("evicts idle runtime state while a retained handle can rehydrate it", async () => {
    let hibernations = 0;
    const hibernated = signal<void>();
    runtime = {
      ...runtime,
      onHibernate: () => {
        hibernations += 1;
        hibernated.resolve();
      },
    };
    const runner: SessionRunner = async () => ({ kind: "result", text: "complete" });
    const options = residentOptions("hibernate", runner);
    const first = session(options, runtime);

    await first.prompt("sleep after this");
    await bounded(hibernated.promise, "runtime hibernation");
    const snapshot = first.get();
    const fenceBeforeGet = snapshot.lease.fence;
    const reopened = session(options, runtime);

    expect(snapshot.state).toBe("idle");
    expect(snapshot.turns.at(-1)?.messages).toEqual([
      { role: "user", text: "sleep after this" },
      { role: "assistant", text: "complete" },
    ]);
    expect(hibernations).toBe(1);
    expect(reopened).not.toBe(first);
    expect(first.get().lease.fence).toBe(fenceBeforeGet);
    await first.prompt("wake again");
    expect(first.get().lease.fence).toBe(fenceBeforeGet + 1);
    expect(hibernations).toBe(2);
  });

  test("resume after interruption carries no prompt content into the runner", async () => {
    const firstEntered = signal<SessionRunnerInput>();
    const firstAborted = signal<void>();
    const resumed = signal<SessionRunnerInput>();
    let entries = 0;
    const runner: SessionRunner = async (input) => {
      entries += 1;
      if (entries === 1) {
        firstEntered.resolve(input);
        input.signal.addEventListener("abort", () => firstAborted.resolve(), { once: true });
        await firstAborted.promise;
        return { kind: "interrupted" };
      }
      resumed.resolve(input);
      return { kind: "result", text: "resumed" };
    };
    const handle = session(residentOptions("content-free-resume", runner), runtime);

    const first = handle.prompt("original prompt");
    const firstInput = await bounded(firstEntered.promise, "initial runner entry");
    await handle.interrupt();
    await bounded(first, "interrupted turn");
    const resume = handle.resume();
    const resumedInput = await bounded(resumed.promise, "resumed runner entry");
    await bounded(resume, "resumed turn");

    expect(resumedInput.messages).toEqual(firstInput.messages);
    expect(resumedInput.resumeCount).toBe(1);
    expect(
      SessionHandleStore.tree(handle.id)
        .map(SessionHandleStore.delivery)
        .filter((item): item is SessionTurn.Delivery => item !== undefined)
        .filter((item) => item.kind === "resume")
        .map((item) => item.content),
    ).toEqual([""]);
  });

  test("materializes a worker as a parent-linked session with an independent lease", async () => {
    const runner: SessionRunner = async () => ({ kind: "result", text: "done" });
    const parent = session(residentOptions("resident-parent", runner), runtime);
    const worker = session(
      {
        id: "worker-child",
        parentId: parent.id,
        role: "worker",
        runner,
        tools: [tool("read")],
        system,
      },
      runtime,
    );

    await worker.prompt("do the work");

    expect(worker.id.startsWith("delegation-")).toBe(false);
    expect(worker.get()).toMatchObject({ parentId: parent.id, role: "worker", revision: 5 });
    expect(SessionHandleStore.row(parent.id).leaseFence).toBe(0);
    expect(SessionHandleStore.row(worker.id).leaseFence).toBe(1);
  });
});

describe("session crash recovery and observation", () => {
  test("boot sweep resumes with the original pre-minted result id", async () => {
    commitOpenTurn({ sessionId: "crashed-turn", resultId: "preminted-result", resumeCount: 0 });
    const entered = signal<SessionRunnerInput>();
    const runner: SessionRunner = async (input) => {
      entered.resolve(input);
      return { kind: "result", text: "recovered" };
    };

    const sweeping = sweepSessions(() => runner, runtime);
    const input = await bounded(entered.promise, "recovered runner entry");
    await bounded(sweeping, "boot sweep terminal");

    expect(input.resultId).toBe("preminted-result");
    expect(input.resumeCount).toBe(1);
    const terminal = SessionHandleStore.tree("crashed-turn").find(
      (action) => SessionHandleStore.turnTerminal(action) !== undefined,
    );
    expect(terminal?.id).toBe("preminted-result");
    expect(SessionHandleStore.openTurns(SessionHandleStore.tree("crashed-turn"))).toEqual([]);
  });

  test("boot sweep seals error at resume budget ten without entering the runner", async () => {
    commitOpenTurn({ sessionId: "poison-turn", resultId: "poison-result", resumeCount: 10 });
    let runnerEntries = 0;
    const runner: SessionRunner = async () => {
      runnerEntries += 1;
      return { kind: "result", text: "must not run" };
    };

    await bounded(
      sweepSessions(() => runner, runtime),
      "resume budget terminal",
    );

    expect(runnerEntries).toBe(0);
    const terminalAction = SessionHandleStore.tree("poison-turn").find(
      (action) => action.id === "poison-result",
    );
    expect(SessionHandleStore.turnTerminal(terminalAction)).toMatchObject({
      kind: "error",
      resumeCount: 10,
    });
  });

  test("watch installs its subscription before reading the initial snapshot", () => {
    SessionHandleStore.materialize({
      id: "watch-order",
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "watch-order:configure",
      at: now,
    });
    let subscribed = false;
    const adapter = Storage.get();
    const sessions = adapter.sessions;
    if (sessions === undefined) throw new Error("session adapter is unavailable");
    const get = sessions.get.bind(sessions);
    Storage.configure({
      ...adapter,
      transaction: adapter.transaction.bind(adapter),
      sessions: {
        ...sessions,
        get: (id) => {
          expect(subscribed).toBe(true);
          return get(id);
        },
      },
    });
    const watch = SessionHandleStore.watchSnapshot("watch-order", 1, {
      publish: () => undefined,
      subscribe: () => {
        subscribed = true;
        return () => undefined;
      },
    });

    watch.unsubscribe();
  });

  test("watch reports a revision gap and get replaces state after a dropped observation", async () => {
    SessionHandleStore.materialize({
      id: "watched-session",
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "watched-session:configure",
      at: now,
    });
    const watch = SessionHandleStore.watchSnapshot("watched-session", 1, sink);
    const observed = signal<SessionTurn.Observation>();
    const stop = watch.subscribe(observed.resolve);
    sink.dropNextCommit = true;

    SessionHandleStore.commitInbox({
      id: "watched-session:prompt-1",
      sessionId: "watched-session",
      kind: "prompt",
      content: "first",
      origin: { encodingVersion: 1, value: { source: "test" } },
      createdAt: now + 1,
      parentActionId: "watched-session:configure",
    });
    SessionHandleStore.commitInbox({
      id: "watched-session:prompt-2",
      sessionId: "watched-session",
      kind: "prompt",
      content: "second",
      origin: { encodingVersion: 1, value: { source: "test" } },
      createdAt: now + 2,
      parentActionId: "watched-session:prompt-1",
    });

    expect(await bounded(observed.promise, "revision gap")).toEqual({
      kind: "gap",
      sessionId: "watched-session",
      from: watch.snapshot.revision,
      to: 3,
    });
    expect(SessionHandleStore.getSnapshot("watched-session").revision).toBe(3);
    stop();
    watch.unsubscribe();
  });
});
