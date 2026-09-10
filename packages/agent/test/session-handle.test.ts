import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { openRequest } from "./helpers/open-request";
import { boundedBy } from "./helpers/bounded";
import type { ExecutionApprovalRequest, ExecutionApprovals } from "../src/executor-contract";
import {
  closeSessions,
  session,
  SessionCommitError,
  type SessionCreateOptions,
  type SessionHandle,
  type SessionRunner,
  type SessionRunnerInput,
  type SessionRuntime,
  sweepSessions,
} from "../src/session-handle";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  type BusEvent,
  type LedgerAction,
  L0Observation,
  PlainValueSchema,
  type ObservationSink,
  type SessionGeneration,
  type SessionTransition,
  type SessionTurn,
} from "@openomni/protocol";
import { Bus } from "../src/index";

const SIGNAL_TIMEOUT_MS = 1_000;
const bounded = boundedBy(SIGNAL_TIMEOUT_MS);

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

/** A runner that ignores abort and only settles once released; tracks its concurrency. */
function stubbornRunner(options: { readonly resumeAfterFirst?: boolean } = {}) {
  const entered = signal<void>();
  const abortSeen = signal<void>();
  const releaseRunner = signal<void>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const runner: SessionRunner = async (input) => {
    calls += 1;
    if (options.resumeAfterFirst && calls > 1) return { kind: "result", text: "resumed" };
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    input.signal.addEventListener("abort", () => abortSeen.resolve(), { once: true });
    entered.resolve();
    await releaseRunner.promise;
    active -= 1;
    return { kind: "result", text: "late" };
  };
  return {
    runner,
    entered,
    abortSeen,
    releaseRunner,
    maximumActive: () => maximumActive,
    calls: () => calls,
  };
}

type StubbornRun = ReturnType<typeof stubbornRunner>;

/** Prompts, waits for the stubborn runner to enter, interrupts, and waits for the abort to reach it. */
async function interruptStubborn(handle: SessionHandle, run: StubbornRun) {
  const running = handle.prompt("start");
  await bounded(run.entered.promise, "runner entry");
  const interrupted = handle.interrupt();
  await bounded(run.abortSeen.promise, "runner abort signal");
  return { running, interrupted };
}

/**
 * The caller-facing interrupt completes at the sealed terminal, not when the
 * abort-ignoring runner finally settles; the lease stays held until then.
 */
async function settleStubborn(
  handle: SessionHandle,
  run: StubbornRun,
  pending: Awaited<ReturnType<typeof interruptStubborn>>,
  hibernated: Signal<void>,
): Promise<void> {
  await bounded(pending.interrupted, "interrupt receipt before runner settlement");
  expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();
  run.releaseRunner.resolve();
  await bounded(
    Promise.all([pending.running, hibernated.promise]),
    "runner settlement + lease release",
  );
}

/** A runner that records every input it receives and answers `text`. */
function recordingRunner(text: string): { runner: SessionRunner; inputs: SessionRunnerInput[] } {
  const inputs: SessionRunnerInput[] = [];
  const runner: SessionRunner = async (input) => {
    inputs.push(input);
    return { kind: "result", text };
  };
  return { runner, inputs };
}

/** No second runtime may take the lease while the stubborn runner lives; once it settles the lease is free. */
async function expectLeaseHeldUntilSettled(
  handle: SessionHandle,
  run: StubbornRun,
  pending: Awaited<ReturnType<typeof interruptStubborn>>,
  hibernated: Signal<void>,
  fence = handle.get().lease.fence,
): Promise<void> {
  expect(contendLease(handle, fence).ok).toBe(false);
  expect(run.maximumActive()).toBe(1);
  await settleStubborn(handle, run, pending, hibernated);
  expect(contendLease(handle).ok).toBe(true);
  expect(run.maximumActive()).toBe(1);
}

/** Declares `id` with a runtime whose hibernation resolves the returned signal. */
function hibernatingSession(
  id: string,
  runner: SessionRunner,
  extra: Partial<SessionRuntime> = {},
): { handle: SessionHandle; hibernated: Signal<void> } {
  const hibernated = signal<void>();
  const handle = session(residentOptions(id, runner), {
    ...runtime,
    ...extra,
    onHibernate: () => hibernated.resolve(),
  });
  return { handle, hibernated };
}

/** A second runtime trying to take the lease right now, without waiting for the TTL. */
function contendLease(handle: SessionHandle, expectedFence = handle.get().lease.fence) {
  return SessionHandleStore.acquireLease({
    sessionId: handle.id,
    owner: "second-runtime",
    expectedFence,
    now,
    expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
  });
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
  seedPolicy();
});

afterEach(async () => {
  await closeSessions(runtime);
  Storage.reset();
  Bus.reset();
});

function residentOptions(id: string, runner: SessionRunner): SessionCreateOptions {
  return { id, role: "resident", runner, tools: [tool("read")], system };
}

function policyHook(action: Pick<LedgerAction.Append, "kind" | "intent">): string | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.hook === "string" ? value.hook : undefined;
}

function policyGeneration(action: LedgerAction.Node): number | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.generation === "number" ? value.generation : undefined;
}

function commitOpenTurn(input: {
  readonly sessionId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly toolsHash?: string;
}): void {
  const created = SessionHandleStore.materialize({
    id: input.sessionId,
    parentId: null,
    role: "resident",
    tools: [tool("read")],
    system,
    policyGeneration: SessionHandleStore.currentPolicyGeneration(),
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
            toolsHash: input.toolsHash ?? generation.toolsHash,
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

function durableRequest(sessionId: string, turnId: string): SessionTransition.Request {
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
  return openRequest({
    requestId: `${sessionId}:request`,
    sessionId,
    turnId,
    callId: `${sessionId}:call`,
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
    deadline: now + 1_000,
    createdAt: now,
  });
}

function approvalRequest(sessionId: string, turnId: string): ExecutionApprovalRequest {
  const durable = durableRequest(sessionId, turnId);
  return {
    durable,
    id: durable.requestId,
    sessionId,
    turnId,
    callId: durable.callId,
    inputHash: durable.inputHash,
    generation: 1,
    revision: 1,
    policyDecisionId: `${sessionId}:decision`,
    intent: {},
  };
}

describe("durable session handle", () => {
  test("records prompt and turn policy once at their existing durable envelopes", async () => {
    const observedBeforeCommit: string[] = [];
    const observedDecisionIds = new Set<string>();
    sink.onCommit = (committed) => {
      if (committed.kind !== "policy.decision") return;
      observedDecisionIds.add(committed.id);
      if (
        !SessionHandleStore.tree("policy-topology").some((action) => action.id === committed.id)
      ) {
        observedBeforeCommit.push(committed.id);
      }
    };
    const policies = Storage.get().policies;
    if (policies === undefined) throw new Error("missing policy adapter");
    const runner: SessionRunner = async () => {
      for (const row of policies.rows(1)) policies.append({ ...row, generation: 2 });
      policies.append({
        name: "deny-new-generation-turn-post",
        kind: "turn",
        phase: "post",
        match: { encodingVersion: 1, value: { op: "session" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "new generation" } },
        priority: 2_000,
        generation: 2,
      });
      return { kind: "result", text: "complete" };
    };
    const handle = session(residentOptions("policy-topology", runner), runtime);

    const result = await handle.prompt("run once");

    const tree = SessionHandleStore.tree(handle.id);
    const prompt = tree.find((action) => action.kind === "prompt");
    const turn = tree.find((action) => SessionHandleStore.turnIntent(action) !== undefined);
    const decisions = tree.filter((action) => action.kind === "policy.decision");
    expect(result).toEqual({ kind: "result", text: "complete" });
    expect(tree.filter((action) => action.kind === "prompt")).toHaveLength(1);
    expect(tree.filter((action) => action.kind === "turn")).toHaveLength(2);
    expect(decisions.map(policyHook).sort()).toEqual([
      "prompt.post",
      "prompt.pre",
      "turn.post",
      "turn.pre",
    ]);
    expect(
      decisions
        .filter((action) => policyHook(action)?.startsWith("prompt."))
        .every((action) => action.parentId === prompt?.id),
    ).toBe(true);
    expect(
      decisions
        .filter((action) => policyHook(action)?.startsWith("turn."))
        .every((action) => action.parentId === turn?.id),
    ).toBe(true);
    expect(decisions.map(policyGeneration)).toEqual([1, 1, 1, 1]);
    expect(observedDecisionIds).toEqual(new Set(decisions.map((action) => action.id)));
    expect(observedBeforeCommit).toEqual([]);
  });

  /** Runs one prompt against an isolated store whose only extra policy row denies prompts at `phase`. */
  async function promptDeniedAt(phase: "pre" | "post", reason: string) {
    return await Storage.withIsolation(async () => {
      Storage.initialize({ dbPath: ":memory:", observationSink: sink });
      seedPolicy([
        {
          name: `deny-prompt-${phase}`,
          kind: "prompt",
          phase,
          match: { encodingVersion: 1, value: { op: "inbox" } },
          verdict: { encodingVersion: 1, value: { type: "deny", reason } },
          priority: 2_000,
        },
      ]);
      const isolatedRuntime = { ...runtime };
      let calls = 0;
      const handle = session(
        residentOptions(`prompt-${phase}-deny`, async () => {
          calls += 1;
          return { kind: "result", text: "must not run" };
        }),
        isolatedRuntime,
      );
      const result = await handle.prompt("blocked prompt");
      const tree = SessionHandleStore.tree(handle.id);
      expect(result).toMatchObject({
        kind: "error",
        cause: { name: "SessionPolicyRefusal", reason },
      });
      expect(calls).toBe(0);
      expect(tree.filter((action) => action.kind === "turn")).toEqual([]);
      const hooks = tree.filter((action) => action.kind === "policy.decision").map(policyHook);
      const inbox = SessionHandleStore.inboxRows(handle.id).map((row) => row.status);
      await closeSessions(isolatedRuntime);
      Storage.reset();
      return { hooks, inbox };
    });
  }

  test("a prompt pre denial consumes the inbox row without constructing or running a turn", async () => {
    const { hooks, inbox } = await promptDeniedAt("pre", "prompt refused");
    expect(hooks).toEqual(["prompt.pre"]);
    expect(inbox).toEqual(["consumed"]);
  });

  test("a prompt post denial records both prompt decisions but never starts a turn", async () => {
    const { hooks } = await promptDeniedAt("post", "prompt post refused");
    expect(hooks).toEqual(["prompt.pre", "prompt.post"]);
  });

  test("fails closed when prompt post policy transforms its immutable receipt", async () => {
    await Storage.withIsolation(async () => {
      Storage.initialize({ dbPath: ":memory:", observationSink: sink });
      seedPolicy([
        {
          name: "transform-prompt-receipt",
          kind: "prompt",
          phase: "post",
          match: { encodingVersion: 1, value: { op: "inbox" } },
          verdict: {
            encodingVersion: 1,
            value: { type: "transform", name: "redact", paths: ["result.status"] },
          },
          priority: 2_000,
        },
      ]);
      const isolatedRuntime = { ...runtime };
      let calls = 0;
      const handle = session(
        residentOptions("prompt-transform", async () => {
          calls += 1;
          return { kind: "result", text: "must not run" };
        }),
        isolatedRuntime,
      );

      const result = await handle.prompt("immutable prompt");

      expect(result).toMatchObject({
        kind: "error",
        cause: { name: "SessionPolicyRefusal", reason: "invalid_output" },
      });
      expect(calls).toBe(0);
      expect(SessionHandleStore.tree(handle.id).filter((action) => action.kind === "turn")).toEqual(
        [],
      );
      await closeSessions(isolatedRuntime);
      Storage.reset();
    });
  });

  test("accepts a turn post transform only when the result still satisfies its contract", async () => {
    for (const path of ["result.usage", "result.text"] as const) {
      await Storage.withIsolation(async () => {
        Storage.initialize({ dbPath: ":memory:", observationSink: sink });
        seedPolicy([
          {
            name: `transform-turn-${path}`,
            kind: "turn",
            phase: "post",
            match: { encodingVersion: 1, value: { op: "session" } },
            verdict: {
              encodingVersion: 1,
              value: { type: "transform", name: "redact", paths: [path] },
            },
            priority: 2_000,
          },
        ]);
        const isolatedRuntime = { ...runtime };
        let calls = 0;
        const handle = session(
          residentOptions(`turn-transform-${path}`, async () => {
            calls += 1;
            return {
              kind: "result",
              text: "typed result",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          }),
          isolatedRuntime,
        );

        const result = await handle.prompt("transform turn result");

        expect(calls).toBe(1);
        if (path === "result.usage") {
          expect(result).toEqual({ kind: "result", text: "typed result" });
        } else {
          expect(result).toMatchObject({
            kind: "error",
            cause: { name: "SessionPolicyRefusal", reason: "invalid_output" },
          });
        }
        await closeSessions(isolatedRuntime);
        Storage.reset();
      });
    }
  });

  for (const sample of [
    {
      name: "required counters",
      valid: true,
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "optional counters",
      valid: true,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    },
    { name: "missing required counter", valid: false, usage: { inputTokens: 4, outputTokens: 5 } },
    {
      name: "invalid optional counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: "invalid",
      },
    },
    {
      name: "unknown counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        unknownTokens: 1,
      },
    },
  ] as const) {
    test(`validates transformed session usage with ${sample.name}`, async () => {
      await Storage.withIsolation(async () => {
        Storage.initialize({ dbPath: ":memory:", observationSink: sink });
        seedPolicy([
          {
            name: "transform-usage",
            kind: "turn",
            phase: "post",
            match: { encodingVersion: 1, value: { op: "session" } },
            verdict: {
              encodingVersion: 1,
              value: {
                type: "transform",
                name: "redact",
                paths: ["result.usage"],
                replacement: PlainValueSchema.parse(sample.usage),
              },
            },
            priority: 2_000,
          },
        ]);
        const isolatedRuntime = { ...runtime };
        try {
          const handle = session(
            residentOptions("usage-transform", async () => ({
              kind: "result",
              text: "result",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            })),
            isolatedRuntime,
          );
          const result = await bounded(handle.prompt("measure"), "transformed usage terminal");
          if (sample.valid) {
            expect(result).toEqual({
              kind: "result",
              text: "result",
              finishReason: "stop",
              usage: sample.usage,
            });
          } else {
            expect(result).toMatchObject({
              kind: "error",
              cause: { name: "SessionPolicyRefusal", reason: "invalid_output" },
            });
          }
          expect(
            SessionHandleStore.tree(handle.id)
              .map(SessionHandleStore.turnTerminal)
              .filter((value) => value !== undefined),
          ).toMatchObject([{ kind: sample.valid ? "result" : "error" }]);
        } finally {
          await closeSessions(isolatedRuntime);
          Storage.reset();
        }
      });
    });
  }

  test("turn policy denial distinguishes body-zero pre from irreversible post", async () => {
    for (const phase of ["pre", "post"] as const) {
      await Storage.withIsolation(async () => {
        Storage.initialize({ dbPath: ":memory:", observationSink: sink });
        seedPolicy([
          {
            name: `deny-turn-${phase}`,
            kind: "turn",
            phase,
            match: { encodingVersion: 1, value: { op: "session" } },
            verdict: {
              encodingVersion: 1,
              value: { type: "deny", reason: `turn ${phase} refused` },
            },
            priority: 2_000,
          },
        ]);
        const isolatedRuntime = { ...runtime };
        let calls = 0;
        const handle = session(
          residentOptions(`turn-${phase}-deny`, async () => {
            calls += 1;
            return { kind: "result", text: "body result" };
          }),
          isolatedRuntime,
        );

        const result = await handle.prompt("start the turn");

        const tree = SessionHandleStore.tree(handle.id);
        const hooks = tree.filter((action) => action.kind === "policy.decision").map(policyHook);
        expect(result).toMatchObject({
          kind: "error",
          cause: { name: "SessionPolicyRefusal", reason: `turn ${phase} refused` },
        });
        expect(calls).toBe(phase === "pre" ? 0 : 1);
        expect(hooks).toEqual(
          phase === "pre"
            ? ["prompt.pre", "prompt.post", "turn.pre"]
            : ["prompt.pre", "prompt.post", "turn.pre", "turn.post"],
        );
        expect(
          tree.map(SessionHandleStore.turnTerminal).find((terminal) => terminal !== undefined),
        ).toMatchObject({ kind: "error" });
        await closeSessions(isolatedRuntime);
        Storage.reset();
      });
    }
  });

  test("refuses a turn when its pinned generation has no mandatory policy row", async () => {
    await Storage.withIsolation(async () => {
      Storage.initialize({ dbPath: ":memory:", observationSink: sink });
      const isolatedRuntime = { ...runtime };
      let calls = 0;
      const handle = session(
        residentOptions("missing-policy", async () => {
          calls += 1;
          return { kind: "result", text: "ran" };
        }),
        isolatedRuntime,
      );

      const result = await handle.prompt("must be refused");

      expect(calls).toBe(0);
      expect(result).toMatchObject({
        kind: "error",
        cause: { name: "SessionPolicyRefusal", code: "session_policy_refused" },
      });
      await closeSessions(isolatedRuntime);
      Storage.reset();
    });
  });

  test("serializes one runner and drains concurrent prompts as distinct ordered messages", async () => {
    const entered = signal<SessionRunnerInput>();
    const releaseBoundary = signal<void>();
    let active = 0;
    let maximumActive = 0;
    let runs = 0;
    const drained: SessionRunnerInput["messages"][] = [];
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
    expect(firstInput.messages).toEqual([
      { id: SessionHandleStore.inboxRows(handle.id)[0]?.id, role: "user", text: "first prompt" },
    ]);
    expect(drained).toEqual([
      [
        { id: SessionHandleStore.inboxRows(handle.id)[1]?.id, role: "user", text: "second prompt" },
        { id: SessionHandleStore.inboxRows(handle.id)[2]?.id, role: "user", text: "third prompt" },
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

  test("a turn's ledger refuses a request transition once that turn has sealed", async () => {
    const entered = signal<SessionRunnerInput>();
    const runner: SessionRunner = async (input) => {
      entered.resolve(input);
      return { kind: "result", text: "done" };
    };
    const handle = session(residentOptions("late-transition", runner), runtime);
    await bounded(handle.prompt("first prompt"), "prompt completion");
    const input = await bounded(entered.promise, "runner entry");
    const request = durableRequest(handle.id, input.turnId);
    const tree = SessionHandleStore.tree(handle.id);
    if (input.ledger.transition === undefined) throw new Error("missing transition port");
    const late = input.ledger.transition({ kind: "request.open", request }, "late:open", now);
    await expect(late).rejects.toBeInstanceOf(SessionCommitError);
    await expect(late).rejects.toMatchObject({ result: { ok: false, reason: "stale" } });
    expect(SessionHandleStore.tree(handle.id)).toEqual(tree);
    expect(SessionHandleStore.requestRows()).toEqual([]);
  });

  test("an interrupt landing during turn.pre admission seals interrupted without entering the runner", async () => {
    let runs = 0;
    const handle = session(
      residentOptions("interrupt-before-body", async () => {
        runs += 1;
        return { kind: "result", text: "ran" };
      }),
      runtime,
    );
    let interrupted: Promise<void> | undefined;
    sink.onCommit = (committed) => {
      if (committed.sessionId !== handle.id || committed.kind !== "policy.decision") return;
      const action = SessionHandleStore.tree(handle.id).find((node) => node.id === committed.id);
      if (action === undefined || policyHook(action) !== "turn.pre" || interrupted !== undefined)
        return;
      interrupted = handle.interrupt();
    };
    const result = await bounded(handle.prompt("never reaches the runner"), "prompt completion");
    if (interrupted === undefined) throw new Error("turn.pre decision was never observed");
    await bounded(interrupted, "interrupt receipt");
    expect(result).toEqual({ kind: "interrupted", text: "" });
    expect(runs).toBe(0);
    expect(handle.get().state).toBe("interrupted");
    expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
  });

  test("a storage failure during turn admission seals the turn as an error", async () => {
    let runs = 0;
    const handle = session(
      residentOptions("admission-storage-failure", async () => {
        runs += 1;
        return { kind: "result", text: "ran" };
      }),
      runtime,
    );
    const sessions = Storage.get().sessions;
    if (sessions === undefined) throw new Error("missing session adapter");
    const commit = sessions.commit;
    const explode = spyOn(sessions, "commit").mockImplementation((input) => {
      const decision = input.actions.find((action) => action.kind === "policy.decision");
      if (decision === undefined || policyHook(decision) !== "turn.pre") return commit(input);
      explode.mockRestore();
      throw new Error("storage exploded during admission");
    });
    const result = await bounded(handle.prompt("admission fails"), "prompt completion");
    expect(result).toMatchObject({ kind: "error", text: "storage exploded during admission" });
    expect(runs).toBe(0);
    expect(handle.get().state).toBe("idle");
    expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
  });

  test("records an idle interrupt as a no-op without resuming the next prompt", async () => {
    const { runner, inputs } = recordingRunner("ran once");
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
    const { runner, inputs } = recordingRunner("ran once");
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
    expect(inputs[0]?.messages).toEqual([
      {
        id: SessionHandleStore.inboxRows(handle.id).find((row) => row.kind === "prompt")?.id,
        role: "user",
        text: "run afterward",
      },
    ]);
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
    const run = stubbornRunner();
    const { handle, hibernated } = hibernatingSession("lease-held-through-abort", run.runner);
    const pending = await interruptStubborn(handle, run);

    // The interrupted terminal is sealed promptly, but the runner ignored the
    // abort and is still alive, so the durable lease MUST stay held by this
    // owner. A second runtime/process acquiring it without waiting for the TTL
    // (no clock advance) must be refused, or two live executors could exist for
    // one durable session.
    expect(handle.get().state).toBe("interrupted");
    await expectLeaseHeldUntilSettled(handle, run, pending, hibernated);
  });

  test("a retained runner whose lease lapsed does not wedge the handle: the next prompt still runs", async () => {
    const { runner, entered, abortSeen, releaseRunner, calls } = stubbornRunner({
      resumeAfterFirst: true,
    });
    const { handle, hibernated } = hibernatingSession("retained-lease-lapsed", runner);

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
    expect(calls()).toBe(2);
    expect(handle.get().state).toBe("idle");
    expect(SessionHandleStore.row(handle.id).leaseFence).toBe(leaseBefore + 1);
  });

  test("a refused retained release surfaces once to the next turn start and then clears", async () => {
    const { runner, entered, abortSeen, releaseRunner, calls } = stubbornRunner({
      resumeAfterFirst: true,
    });
    const handle = session(residentOptions("retained-release-refused", runner), runtime);
    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    await bounded(handle.interrupt(), "interrupt receipt");
    await bounded(abortSeen.promise, "runner abort signal");

    const sessions = Storage.get().sessions;
    if (sessions === undefined) throw new Error("missing session adapter");
    const commit = sessions.commit;
    const releaseRefused = signal<void>();
    const refuseRelease = spyOn(sessions, "commit").mockImplementation((input) => {
      if (input.releaseLease && input.actions.length === 0 && input.sessionId === handle.id) {
        refuseRelease.mockRestore();
        releaseRefused.resolve();
        throw new Error("release refused by storage");
      }
      return commit(input);
    });
    releaseRunner.resolve();
    await bounded(Promise.all([running, releaseRefused.promise]), "retained settlement");

    await expect(handle.resume()).rejects.toThrow("release refused by storage");
    await bounded(handle.resume(), "resume after the surfaced failure");
    expect(calls()).toBe(2);
    expect(handle.get().state).toBe("idle");
    expect(SessionHandleStore.pendingInbox(handle.id)).toEqual([]);
  });

  test("configure during the ignored-abort window keeps the lease held by the live runner", async () => {
    const run = stubbornRunner();
    const { handle, hibernated } = hibernatingSession("configure-in-interrupt-window", run.runner);
    const pending = await interruptStubborn(handle, run);
    expect(handle.get().state).toBe("interrupted");
    const fenceBefore = handle.get().lease.fence;

    // A configure while the abort-ignoring runner is still alive must neither
    // rotate the fence nor release the lease: the live executor still owns it.
    const receipt = await bounded(handle.tools.add([tool("search")]), "configure receipt");
    expect(receipt.generation).toBeGreaterThan(0);
    const afterConfigure = handle.get();
    expect(afterConfigure.lease.fence).toBe(fenceBefore);
    expect(afterConfigure.lease.owner).not.toBeNull();
    await expectLeaseHeldUntilSettled(handle, run, pending, hibernated, afterConfigure.lease.fence);
  });

  test("configure re-entered from the interrupted seal observation still sees the lease as held", async () => {
    const run = stubbornRunner();
    const { entered } = run;
    const { handle, hibernated } = hibernatingSession(
      "configure-from-seal-observation",
      run.runner,
    );
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
    expect(contendLease(handle, row.leaseFence).ok).toBe(false);

    await settleStubborn(handle, run, { running, interrupted }, hibernated);
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
    expect(run.maximumActive()).toBe(1);
  });

  test("close() returns once a positive grace window lapses while the runner still ignores abort", async () => {
    const { runner, entered, releaseRunner } = stubbornRunner();
    const { handle, hibernated } = hibernatingSession("close-after-positive-grace", runner, {
      closeGraceMs: 1,
    });

    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    // The interrupt seals the turn while the abort-ignoring runner stays retained,
    // so close() can only return once the grace timer lapses.
    await bounded(handle.interrupt(), "interrupt receipt");
    await bounded(handle.close(), "close after grace lapse");
    expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();

    releaseRunner.resolve();
    await bounded(Promise.all([running, hibernated.promise]), "runner settlement + lease release");
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
  });

  test("close() returns after the grace window while the lease stays held until the abort-ignoring runner settles", async () => {
    const { runner, entered, releaseRunner, maximumActive } = stubbornRunner();
    const { handle, hibernated } = hibernatingSession("close-detaches-after-grace", runner, {
      closeGraceMs: 0,
    });

    const running = handle.prompt("start");
    await bounded(entered.promise, "runner entry");
    await bounded(handle.close(), "close with zero grace");

    // Detached from the caller only: the lease is still held by this executor
    // and its heartbeat keeps renewing, so no second executor can start.
    const row = SessionHandleStore.row(handle.id);
    expect(row.leaseOwner).not.toBeNull();
    expect(contendLease(handle, row.leaseFence).ok).toBe(false);

    // Once the runner settles the turn continuation releases the lease itself.
    releaseRunner.resolve();
    await bounded(Promise.all([running, hibernated.promise]), "runner settlement + lease release");
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
    expect(contendLease(handle, SessionHandleStore.row(handle.id).leaseFence).ok).toBe(true);
    expect(maximumActive()).toBe(1);
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

  test("a reactivated handle removes a tool from the next runner generation", async () => {
    const { runner, inputs } = recordingRunner("complete");
    const handle = session(
      {
        ...residentOptions("remove-after-reactivation", runner),
        tools: [tool("read"), tool("search")],
      },
      runtime,
    );

    await handle.prompt("hibernate the original controller");
    const receipt = await handle.tools.remove(["read"]);
    await handle.prompt("use the configured generation");

    expect(receipt).toEqual({ generation: 2, revertTo: 1 });
    expect(inputs.at(-1)?.tools.map((entry) => entry.name)).toEqual(["search"]);
  });

  test("a reactivated handle replaces system blocks for the next runner generation", async () => {
    const { runner, inputs } = recordingRunner("complete");
    const handle = session(residentOptions("blocks-after-reactivation", runner), runtime);
    const nextBlocks = [{ id: "safety", source: "operator", content: "Use the safe path." }];

    await handle.prompt("hibernate the original controller");
    const receipt = await handle.system.blocks.set(nextBlocks);
    await handle.prompt("use the configured generation");

    expect(receipt).toEqual({ generation: 2, revertTo: 1 });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.systemHash).not.toBe(inputs[0]?.systemHash);
    expect(inputs[1]?.tools.map((entry) => entry.name)).toEqual(["read"]);
    expect(
      SessionHandleStore.latestGeneration(SessionHandleStore.tree(handle.id)).systemBlocks,
    ).toEqual(nextBlocks);
  });

  test("reports typed lease contention from the SQLite-backed session API", async () => {
    const runner: SessionRunner = async () => ({ kind: "result", text: "must not run" });
    const handle = session(residentOptions("lease-contention", runner), runtime);
    const acquired = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "other-process",
      expectedFence: 0,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    if (!acquired.ok) throw new Error("contention fixture could not acquire its lease");

    await expect(handle.prompt("contended turn")).rejects.toMatchObject({
      name: "SessionLeaseError",
      message: "session lease held",
      result: {
        ok: false,
        reason: "held",
        holder: "other-process",
        expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
      },
    });
  });

  test("default heartbeat uses an unreferenced timer and clears it after the runner settles", async () => {
    const entered = signal<void>();
    const release = signal<void>();
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    const runner: SessionRunner = async () => {
      entered.resolve();
      await release.promise;
      return { kind: "result", text: "complete" };
    };
    const handle = session(residentOptions("default-heartbeat", runner), {
      observations: sink,
      clock: runtime.clock,
      entropy: runtime.entropy,
      processId: runtime.processId,
    });

    const running = handle.prompt("start");
    try {
      await bounded(entered.promise, "default-heartbeat runner entry");
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const timer = setIntervalSpy.mock.results[0]?.value;
      if (
        typeof timer !== "object" ||
        timer === null ||
        !("hasRef" in timer) ||
        typeof timer.hasRef !== "function"
      ) {
        throw new Error("default heartbeat did not return a timer handle");
      }
      expect(timer.hasRef()).toBe(false);
      release.resolve();
      await bounded(running, "default-heartbeat runner completion");
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      release.resolve();
      await bounded(running, "default-heartbeat cleanup");
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
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

  test("a hibernated handle routes restore and close through its live successor", async () => {
    const hibernated = signal<void>();
    runtime = { ...runtime, onHibernate: () => hibernated.resolve() };
    const runner: SessionRunner = async () => ({ kind: "result", text: "complete" });
    const options = residentOptions("hibernate-successor", runner);
    const first = session(options, runtime);
    await bounded(first.prompt("sleep after this"), "first prompt");
    await bounded(hibernated.promise, "runtime hibernation");
    const successor = session(options, runtime);
    expect(successor).not.toBe(first);

    await expect(first.restoreContext("missing-compaction")).rejects.toMatchObject({
      name: "ContextRestoreError",
      code: "context_restore_refused",
      reason: "unknown_compaction",
    });
    await bounded(first.close(), "close through successor");
    expect(() => successor.prompt("after close")).toThrow("session handle is closed");
    expect(() => first.prompt("after close")).toThrow("session handle is closed");
  });

  test("approval answers reach only a turn's live approvals", async () => {
    const answers: Parameters<ExecutionApprovals["answer"]>[0][] = [];
    const entered = signal<void>();
    const release = signal<void>();
    const livePending: ExecutionApprovalRequest[] = [];
    const runner: SessionRunner = async (input) => {
      input.bindApprovals?.({
        pending: () => livePending,
        notify: () => undefined,
        answer: async (answer) => {
          answers.push(answer);
        },
      });
      entered.resolve();
      await release.promise;
      return { kind: "result", text: "done" };
    };
    const handle = session(residentOptions("approval-routing", runner), runtime);
    const request = approvalRequest(handle.id, "turn");
    livePending.push(request);
    const answer = {
      request,
      credential: "owner-token",
      decision: "approve",
    } as const;
    expect(handle.approvals.pending()).toEqual([]);
    await expect(handle.approvals.answer(answer)).rejects.toMatchObject({
      code: "stale_approval",
    });
    const prompted = handle.prompt("needs approval");
    await bounded(entered.promise, "runner entry");
    expect(handle.approvals.pending()).toBe(livePending);
    await bounded(handle.approvals.answer(answer), "routed answer");
    expect(answers).toEqual([answer]);
    release.resolve();
    await bounded(prompted, "prompt completion");
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

  test.each([
    "result",
    "error",
    "interrupted",
  ] as const)("child %s terminal offers the original parent letter to the atomic commit port", async (kind) => {
    const parent = session(
      residentOptions("request-parent", async () => ({ kind: "result", text: "parent" })),
      runtime,
    );
    expect(
      Storage.get().actions?.append(
        {
          id: "original-send",
          sessionId: parent.id,
          parentId: null,
          kind: "message",
          intent: { encodingVersion: 1, value: { phase: "intent", messageId: "request" } },
          effect: { encodingVersion: 1, value: { phase: "pending" } },
          irreversible: true,
          ts: now,
        },
        SessionHandleStore.row(parent.id).revision,
      ),
    ).toBeDefined();
    let commits = 0;
    runtime = {
      ...runtime,
      dispatchOutbound: async ({ message }) => {
        commits += 1;
        expect(
          SessionHandleStore.tree(message.sourceSessionId).some(
            (action) => SessionHandleStore.turnTerminal(action) !== undefined,
          ),
        ).toBe(true);
        expect(SessionHandleStore.outboundRows(message.sourceSessionId)[0]?.state).toBe("pending");
        expect(SessionHandleStore.inboxRows(parent.id)).toEqual([]);
        expect(message).toMatchObject({
          requestId: "original-send",
          replyTo: "original-binding",
          sourceSessionId: "reply-child",
          terminal: kind === "result" ? "completed" : kind,
        });
        return SessionHandleStore.commitReceivedMessage({
          id: message.messageId,
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: message.content,
          createdAt: now,
          parentActionId: null,
          origin: { encodingVersion: 1, value: message },
        }).receipt;
      },
    };
    const worker = session(
      {
        id: "reply-child",
        parentId: parent.id,
        role: "worker",
        tools: [],
        system,
        runner: async () => ({ kind, text: "terminal-text" }),
      },
      runtime,
    );
    await worker.prompt("work", {
      encodingVersion: 1,
      value: {
        kind: "message",
        messageId: "request",
        senderSessionId: parent.id,
        sourceActionId: "original-send",
        replyTo: "original-binding",
        deadline: now + 1000,
      },
    });
    expect(commits).toBe(1);
    expect(SessionHandleStore.inboxRows(parent.id).map((row) => row.content)).toEqual([
      "terminal-text",
    ]);
    expect(
      SessionHandleStore.tree(worker.id).flatMap((action) => {
        const terminal = SessionHandleStore.turnTerminal(action);
        return terminal === undefined ? [] : [terminal.kind];
      }),
    ).toEqual([kind]);
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
    expect(worker.get()).toMatchObject({ parentId: parent.id, role: "worker", revision: 9 });
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

  test("boot sweep refuses an open turn whose pinned generation no longer matches the ledger", async () => {
    commitOpenTurn({
      sessionId: "drifted-turn",
      resultId: "drifted-result",
      resumeCount: 0,
      toolsHash: "not-the-recorded-tools",
    });
    let runs = 0;
    const sweeping = sweepSessions(
      () => async () => {
        runs += 1;
        return { kind: "result", text: "must not run" };
      },
      runtime,
    );
    await expect(sweeping).rejects.toThrow("pinned session generation unavailable: 1");
    expect(runs).toBe(0);
    expect(SessionHandleStore.openTurns(SessionHandleStore.tree("drifted-turn"))).toHaveLength(1);
  });

  test("a prompt denied at a mid-turn boundary is consumed and fails the runner's drain", async () => {
    await Storage.withIsolation(async () => {
      Storage.initialize({ dbPath: ":memory:", observationSink: sink });
      seedPolicy([
        {
          name: "deny-boundary-prompt",
          kind: "prompt",
          phase: "pre",
          match: { encodingVersion: 1, value: { op: "inbox", sessionId: "boundary-deny" } },
          verdict: { encodingVersion: 1, value: { type: "deny", reason: "late prompt refused" } },
          priority: 2_000,
        },
      ]);
      commitOpenTurn({ sessionId: "boundary-deny", resultId: "boundary-result", resumeCount: 0 });
      const isolatedRuntime = { ...runtime };
      const drained = signal<unknown>();
      const runner: SessionRunner = async (input) => {
        SessionHandleStore.commitInbox({
          id: "boundary-deny:late",
          sessionId: input.sessionId,
          kind: "prompt",
          content: "late prompt",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: SessionHandleStore.tree(input.sessionId).at(-1)?.id ?? null,
        });
        try {
          return { kind: "result", text: JSON.stringify(await input.boundary("after_llm")) };
        } catch (error) {
          drained.resolve(error);
          throw error;
        }
      };
      await bounded(
        sweepSessions(() => runner, isolatedRuntime),
        "boot sweep terminal",
      );
      expect(await bounded(drained.promise, "boundary refusal")).toMatchObject({
        name: "SessionPolicyRefusal",
        reason: "late prompt refused",
      });
      const tree = SessionHandleStore.tree("boundary-deny");
      expect(
        SessionHandleStore.turnTerminal(tree.find((action) => action.id === "boundary-result")),
      ).toMatchObject({ kind: "error", text: "session policy refused" });
      expect(tree.filter((action) => action.kind === "policy.decision").map(policyHook)).toEqual([
        "turn.pre",
        "prompt.pre",
        "turn.post",
      ]);
      expect(tree.map(SessionHandleStore.delivery).filter((d) => d !== undefined)).toEqual([]);
      expect(SessionHandleStore.inboxRows("boundary-deny").map((row) => row.status)).toEqual([
        "consumed",
      ]);
      await closeSessions(isolatedRuntime);
      Storage.reset();
    });
  });

  test("boot sweep seals a durable interrupt before admitting an open turn", async () => {
    commitOpenTurn({ sessionId: "cancelled-turn", resultId: "cancelled-result", resumeCount: 0 });
    SessionHandleStore.commitInbox({
      id: "cancel-request",
      sessionId: "cancelled-turn",
      kind: "interrupt",
      content: "",
      createdAt: now,
      origin: { encodingVersion: 1, value: { kind: "sdk" } },
      parentActionId: "cancelled-turn:turn",
    });
    const prefix = SessionHandleStore.tree("cancelled-turn");
    let runnerEntries = 0;
    await bounded(
      sweepSessions(
        () => async () => {
          runnerEntries += 1;
          return { kind: "result", text: "must not run" };
        },
        runtime,
      ),
      "cancelled open turn seal",
    );
    expect(runnerEntries).toBe(0);
    const actions = SessionHandleStore.tree("cancelled-turn");
    expect(actions.slice(0, prefix.length)).toEqual(prefix);
    expect(
      SessionHandleStore.turnTerminal(actions.find((action) => action.id === "cancelled-result")),
    ).toMatchObject({ kind: "interrupted", turnId: "cancelled-turn:turn", resumeCount: 0 });
    expect(SessionHandleStore.pendingInbox("cancelled-turn")).toEqual([]);
    expect(SessionHandleStore.row("cancelled-turn").leaseOwner).toBeNull();
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

  test("a resume for an interrupted session without any terminal is consumed as a no-op", async () => {
    const runs: string[] = [];
    const handle = session(
      residentOptions("interrupted-without-terminal", async (input) => {
        runs.push(input.turnId);
        return { kind: "result", text: "never" };
      }),
      runtime,
    );
    const row = SessionHandleStore.row(handle.id);
    const lease = SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "earlier-runtime",
      expectedFence: row.leaseFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    if (!lease.ok) throw new Error("test lease refused");
    const marked = SessionHandleStore.commit({
      sessionId: handle.id,
      owner: "earlier-runtime",
      fence: lease.fence,
      now,
      expectedRevision: SessionHandleStore.row(handle.id).revision,
      actions: [],
      consumeInboxIds: [],
      state: "interrupted",
      releaseLease: true,
    });
    if (!marked.ok) throw new Error("test interrupt refused");

    expect(await bounded(handle.resume(), "resume without terminal")).toBeUndefined();
    expect(runs).toEqual([]);
    expect(handle.get().state).toBe("interrupted");
    expect(SessionHandleStore.pendingInbox(handle.id)).toEqual([]);
    expect(
      SessionHandleStore.tree(handle.id)
        .map(SessionHandleStore.delivery)
        .filter((delivery): delivery is SessionTurn.Delivery => delivery !== undefined)
        .map((delivery) => delivery.turnId),
    ).toEqual(["noop"]);
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
    const handle = session(
      residentOptions("watched-session", async () => ({ kind: "result", text: "unused" })),
      runtime,
    );
    const configureId = SessionHandleStore.tree(handle.id)[0]?.id;
    if (configureId === undefined) throw new Error("missing configure action");
    const watch = handle.watch();
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
      parentActionId: configureId,
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
    expect(handle.get().revision).toBe(3);
    stop();
    watch.unsubscribe();
  });
});
