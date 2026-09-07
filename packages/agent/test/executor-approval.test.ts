import { afterEach, beforeEach, expect, it } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { canonicalDigest, type SessionTransition } from "@openomni/protocol";
import { createExecutor, type ExecutorOptions } from "../src/executor";
import { compiledPolicy } from "./helpers/compiled-policy";
import { bounded, requestLedger } from "./helpers/request-ledger";

const policy = compiledPolicy([
  {
    name: "approve-write",
    kind: "tool",
    phase: "pre",
    match: { encodingVersion: 1, value: { op: "write" } },
    verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
    priority: 1,
    generation: 1,
  },
]);
const evidence = { kind: "owner", principalId: "owner", evidenceId: "auth-1" } as const;
const request = {
  kind: "tool",
  op: "write",
  intent: { path: "approved.txt" },
  effect: { category: "mutation" },
  toolObservation: { turnId: "turn", callId: "call-1" },
};
beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());

function fixture(overrides: Partial<ExecutorOptions> = {}) {
  const opened = Promise.withResolvers<SessionTransition.Request>();
  const recording = requestLedger({
    clock: overrides.clock,
    onRequest: (request) => {
      if (request.state === "open") opened.resolve(request);
    },
  });
  const executor = createExecutor({
    ...recording,
    policy,
    authorizeApproval: async () => evidence,
    observations: { publish: () => undefined },
    ...overrides,
  });
  const controller = new AbortController();
  const bodies: string[] = [];
  if (executor.runBatch === undefined) throw new Error("missing wave executor");
  const running = executor.runBatch(
    [
      {
        request: { ...request, op: "read" },
        async body() {
          bodies.push("read");
          return {};
        },
      },
      {
        request,
        async body() {
          bodies.push("write");
          return { status: "success" };
        },
      },
      {
        request: { ...request, op: "last" },
        sequential: true,
        async body() {
          bodies.push("last");
          return {};
        },
      },
    ],
    { signal: controller.signal },
  );
  const approvals = executor.approvals;
  if (approvals === undefined) throw new Error("missing approvals");
  return { ...recording, executor, controller, bodies, running, approvals, opened: opened.promise };
}
for (const decision of ["approve", "refuse"] as const) {
  it(`commits authenticated ${decision} on the original invocation before opening the whole wave`, async () => {
    const f = fixture();
    try {
      const durable = await bounded(f.opened);
      const pending = f.approvals.pending()[0];
      if (pending === undefined) throw new Error("missing approval");
      expect(durable.inputHash).toBe(canonicalDigest(request.intent));
      expect(durable.parsedInput).toEqual(request.intent);
      expect(
        SessionHandleStore.tree(f.identity.sessionId).find(
          (action) => action.id === durable.requestId,
        )?.kind,
      ).toBe("tool");
      expect(f.bodies).toEqual([]);
      await f.approvals.answer({ request: pending, credential: "owner-token", decision });
      const results = await bounded(f.running);
      expect(results[1]).toEqual(
        decision === "approve"
          ? { terminal: "executed", value: { status: "success" } }
          : { terminal: "blocked_pre", reason: "approval_refused" },
      );
      expect(f.bodies).toEqual(
        decision === "approve" ? ["read", "write", "last"] : ["read", "last"],
      );
      expect(
        SessionHandleStore.tree(f.identity.sessionId).filter(
          (action) => action.id === `${pending.id}:resolution`,
        ),
      ).toHaveLength(1);
      await expect(
        f.approvals.answer({ request: pending, credential: "owner-token", decision }),
      ).rejects.toMatchObject({ code: "stale_approval" });
    } finally {
      f.controller.abort();
      await bounded(Promise.allSettled([f.running]));
    }
  });
}
it("rejects forged input, changed domain facts and unavailable Owner authority", async () => {
  const f = fixture({ authorizeApproval: undefined });
  try {
    await bounded(f.opened);
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    await expect(
      f.approvals.answer({
        request: { ...pending, toolsHash: "forged" },
        credential: "x",
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "stale_approval" });
    await expect(
      f.approvals.answer({ request: pending, credential: "x", decision: "approve" }),
    ).rejects.toMatchObject({ code: "approval_authority_unavailable" });
    expect(f.bodies).toEqual([]);
    f.controller.abort();
    expect((await bounded(f.running)).every((result) => result.terminal === "cancelled")).toBe(
      true,
    );
    expect(SessionHandleStore.requestById(pending.id)?.state).toBe("cancelled");
  } finally {
    f.controller.abort();
    await bounded(Promise.allSettled([f.running]));
  }
});
it("rechecks cancellation after asynchronous authentication", async () => {
  const authorizing = Promise.withResolvers<void>();
  const authenticated = Promise.withResolvers<typeof evidence>();
  const f = fixture({
    authorizeApproval: () => {
      authorizing.resolve();
      return authenticated.promise;
    },
  });
  try {
    await bounded(f.opened);
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    const settled = Promise.allSettled([
      f.approvals.answer({ request: pending, decision: "approve", credential: "x" }),
    ]);
    await bounded(authorizing.promise);
    f.controller.abort();
    await bounded(f.running);
    authenticated.resolve(evidence);
    expect(await bounded(settled)).toMatchObject([
      { status: "rejected", reason: { code: "stale_approval" } },
    ]);
    expect(f.bodies).toEqual([]);
  } finally {
    authenticated.resolve(evidence);
    f.controller.abort();
    await bounded(Promise.allSettled([f.running]));
  }
});
it("expires exactly once at the deadline, even with a delayed callback", async () => {
  let now = 100;
  let cancelled = 0;
  const scheduled = Promise.withResolvers<() => void>();
  const f = fixture({
    clock: () => now,
    approvalTimeoutMs: 25,
    scheduleApprovalTimeout(expire) {
      scheduled.resolve(expire);
      return () => {
        cancelled += 1;
      };
    },
  });
  try {
    const expire = await bounded(scheduled.promise);
    expire();
    expect(f.bodies).toEqual([]);
    now = 125;
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    await expect(
      f.approvals.answer({ request: pending, credential: "x", decision: "approve" }),
    ).rejects.toMatchObject({ code: "stale_approval" });
    expect(SessionHandleStore.requestById(pending.id)?.state).toBe("expired");
    expire();
    expect((await bounded(f.running))[1]).toEqual({
      terminal: "blocked_pre",
      reason: "approval_timeout",
    });
    expire();
    expect(SessionHandleStore.requestById(pending.id)?.state).toBe("expired");
    expect(
      SessionHandleStore.tree(f.identity.sessionId).filter(
        (action) => action.id === `${pending.id}:resolution`,
      ),
    ).toHaveLength(1);
    expect(cancelled).toBe(1);
  } finally {
    f.controller.abort();
    await bounded(Promise.allSettled([f.running]));
  }
});
it("handles immediate expiry through the native scheduler", async () => {
  const f = fixture({ approvalTimeoutMs: 0 });
  expect((await bounded(f.running))[1]).toEqual({
    terminal: "blocked_pre",
    reason: "approval_timeout",
  });
  expect(f.bodies).toEqual(["read", "last"]);
});
it("rejects invalid deadlines before admitting execution", () => {
  const recording = requestLedger();
  for (const approvalTimeoutMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      createExecutor({
        ...recording,
        policy,
        observations: { publish: () => undefined },
        approvalTimeoutMs,
      }),
    ).toThrow(TypeError);
  }
});

it("does not treat an uncommitted notification as approval authority", async () => {
  const f = fixture();
  try {
    const request = await bounded(f.opened);
    f.approvals.notify?.({ ...request, state: "resolved", outcome: "answered" });
    expect(f.bodies).toEqual([]);
    expect(f.approvals.pending()).toHaveLength(1);
    expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("open");
  } finally {
    f.controller.abort();
    await bounded(f.running);
  }
});

it("propagates a failed deadline commit and clears its live suspension", async () => {
  const recording = requestLedger({ id: "deadline-failure" });
  const transition = recording.ledger.transition;
  if (transition === undefined) throw new Error("missing transition");
  const failure = new Error("deadline storage unavailable");
  let cancelled = 0;
  const f = fixture({
    ...recording,
    approvalTimeoutMs: 0,
    ledger: {
      ...recording.ledger,
      async transition(payload, inputId, at) {
        if (payload.kind === "request.timeout") throw failure;
        return transition(payload, inputId, at);
      },
    },
    scheduleApprovalTimeout() {
      return () => {
        cancelled += 1;
      };
    },
  });
  expect(await bounded(Promise.allSettled([f.running]))).toEqual([
    { status: "rejected", reason: failure },
  ]);
  expect(f.bodies).toEqual([]);
  expect(f.approvals.pending()).toEqual([]);
  expect(cancelled).toBe(1);
  expect(SessionHandleStore.requestRows("deadline-failure")[0]?.state).toBe("open");
});
