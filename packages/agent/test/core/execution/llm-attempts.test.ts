import { expect, test } from "bun:test";
import { Run } from "@openomni/llm";
import { createExecutor, type ExecutorOptions } from "../../../src/executor";
import { compiledPolicy, recordingLedger } from "../../helpers/compiled-policy";
import type { LedgerAction } from "@openomni/protocol";

const usage = {
  inputTokens: 17,
  outputTokens: 2,
  reasoningTokens: 1,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
};
function providerFailure(visibleOutput = false) {
  return new Run.FailureError(
    {
      message: "overloaded",
      aborted: false,
      contextOverflow: false,
      visibleOutput,
      usage,
    },
    {
      cause: Object.assign(new Error("overloaded"), {
        isRetryable: true,
        statusCode: 529,
        responseHeaders: { "retry-after-ms": "0" },
      }),
    },
  );
}

function harness(overrides: Partial<ExecutorOptions> = {}) {
  const record = recordingLedger();
  const waits: number[] = [];
  const executor = createExecutor({
    ledger: record.ledger,
    policy: compiledPolicy(),
    clock: () => 1,
    entropy: record.entropy,
    identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
    observations: { publish: () => undefined },
    waitRetry: async (delay) => {
      waits.push(delay);
    },
    ...overrides,
  });
  return { ...record, executor, waits };
}
function intents(actions: readonly LedgerAction.Append[], kind: LedgerAction.Kind) {
  return actions.filter(
    (a) =>
      a.kind === kind &&
      typeof a.intent.value === "object" &&
      a.intent.value !== null &&
      !Array.isArray(a.intent.value) &&
      a.intent.value.phase === "intent",
  );
}

test("executor admits ordered retry children and retains every failed billed usage", async () => {
  const { executor, committed, waits } = harness();
  const admissions: number[] = [];
  let calls = 0;
  const result = await executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) =>
    executor.runAttempts(parent, {
      prepare: async (attempt) => ({
        request: { op: "chat", intent: { attempt }, effect: {} },
        admit: async () => {
          admissions.push(attempt);
        },
        body: async () => {
          calls += 1;
          if (calls < 3) throw providerFailure();
          return { type: "stop" };
        },
      }),
    }),
  );
  expect(result).toMatchObject({ terminal: "executed", value: { type: "stop" } });
  expect(admissions).toEqual([1, 2, 3]);
  expect(waits).toEqual([0, 0]);
  const parents = intents(committed, "llm");
  const attempts = intents(committed, "attempt");
  expect(parents).toHaveLength(1);
  expect(attempts.map((a) => a.parentId)).toEqual(new Array(3).fill(parents[0]?.id));
  const failed = committed.filter(
    (a) =>
      a.kind === "attempt" &&
      typeof a.effect.value === "object" &&
      a.effect.value !== null &&
      !Array.isArray(a.effect.value) &&
      a.effect.value.terminal === "failed",
  );
  expect(failed).toHaveLength(2);
  for (const result of failed) expect(result.effect.value).toMatchObject({ failure: { usage } });
  expect(
    committed.filter(
      (a) =>
        a.kind === "policy.decision" &&
        typeof a.intent.value === "object" &&
        a.intent.value !== null &&
        !Array.isArray(a.intent.value) &&
        a.intent.value.hook === "llm.pre",
    ),
  ).toHaveLength(3);
});

test("visible output makes a provider failure terminal without a second admission", async () => {
  const { executor, committed, waits } = harness();
  const failure = providerFailure(true);
  let calls = 0;
  await expect(
    executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) =>
      executor.runAttempts(parent, {
        prepare: async () => ({
          request: { op: "chat", intent: {}, effect: {} },
          admit: async () => undefined,
          body: async () => {
            calls += 1;
            throw failure;
          },
        }),
      }),
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(waits).toEqual([]);
  expect(intents(committed, "attempt")).toHaveLength(1);
});

test("retry cap retains three failed children and never invokes a fourth body", async () => {
  const { executor, committed, waits } = harness();
  let calls = 0;
  await expect(
    executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) =>
      executor.runAttempts(parent, {
        prepare: async () => ({
          request: { op: "chat", intent: {}, effect: {} },
          admit: async () => undefined,
          body: async () => {
            calls += 1;
            throw providerFailure();
          },
        }),
      }),
    ),
  ).rejects.toBeInstanceOf(Run.FailureError);
  expect(calls).toBe(3);
  expect(waits).toEqual([0, 0]);
  expect(intents(committed, "attempt")).toHaveLength(3);
});

test("retry re-evaluates policy and context before admitting another child", async () => {
  for (const refuse of ["policy", "context"] as const) {
    const { executor, committed } = harness({
      policy: compiledPolicy(
        refuse === "policy"
          ? [
              {
                name: "retry-denied",
                kind: "llm",
                phase: "pre",
                priority: 1000,
                generation: 1,
                match: { encodingVersion: 1, value: { op: "retry" } },
                verdict: { encodingVersion: 1, value: { type: "deny", reason: "denied" } },
              },
            ]
          : [],
      ),
    });
    let calls = 0;
    await expect(
      executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) =>
        executor.runAttempts(parent, {
          prepare: async (attempt) => ({
            request: { op: attempt === 1 ? "chat" : "retry", intent: {}, effect: {} },
            admit: async () => {
              if (attempt > 1) throw new Error("context denied");
            },
            body: async () => {
              calls += 1;
              throw providerFailure();
            },
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(intents(committed, "attempt")).toHaveLength(1);
  }
});

test("interrupt cancels an exactly registered backoff without another provider admission", async () => {
  const registered = Promise.withResolvers<void>();
  const controller = new AbortController();
  let cancelled = false;
  const { executor, committed } = harness({
    signal: controller.signal,
    waitRetry: (_delay, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
        registered.resolve();
      }),
  });
  const running = executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) =>
    executor.runAttempts(parent, {
      prepare: async () => ({
        request: { op: "chat", intent: {}, effect: {} },
        admit: async () => undefined,
        body: async () => {
          throw providerFailure();
        },
      }),
    }),
  );
  const terminal = running.catch((error: Error) => error);
  await registered.promise;
  controller.abort();
  expect(await terminal).toBeInstanceOf(DOMException);
  expect(cancelled).toBe(true);
  expect(intents(committed, "attempt")).toHaveLength(1);
});

test("retry approval suspends the captured child without reconstructing the provider call", async () => {
  const waiting = Promise.withResolvers<void>();
  const { executor, committed } = harness({
    policy: compiledPolicy([
      {
        name: "retry-approval",
        kind: "llm",
        phase: "pre",
        priority: 1000,
        generation: 1,
        match: { encodingVersion: 1, value: { op: "retry" } },
        verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
      },
    ]),
    authorizeApproval: async () => ({
      kind: "owner",
      principalId: "owner",
      evidenceId: "authenticated",
    }),
    observations: {
      publish() {
        if (executor.approvals?.pending().length) waiting.resolve();
      },
    },
  });
  let calls = 0;
  let prepared = 0;
  const running = executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) =>
    executor.runAttempts(parent, {
      prepare: async (attempt) => {
        prepared += 1;
        return {
          request: { op: attempt === 1 ? "chat" : "retry", intent: { attempt }, effect: {} },
          admit: async () => undefined,
          body: async () => {
            calls += 1;
            if (calls === 1) throw providerFailure();
            return { type: "stop" };
          },
        };
      },
    }),
  );
  await waiting.promise;
  expect(calls).toBe(1);
  const request = executor.approvals?.pending()[0];
  if (request === undefined) throw new Error("missing retry approval");
  expect(intents(committed, "attempt").map((action) => action.id)).toContain(request.id);
  await executor.approvals?.answer({ request, credential: "proof", decision: "approve" });
  expect(await running).toMatchObject({ terminal: "executed" });
  expect(calls).toBe(2);
  expect(prepared).toBe(2);
  expect(intents(committed, "llm")).toHaveLength(1);
});
