import { afterEach, beforeEach, expect, it } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { canonicalDigest, type SessionTransition } from "@openomni/protocol";
import { createExecutor, type ExecutorOptions } from "../src/executor";
import { approveWriteRow, compiledPolicy } from "./helpers/compiled-policy";
import { requestLedger } from "./helpers/request-ledger";
import { bounded } from "./helpers/bounded";

const policy = compiledPolicy([approveWriteRow]);
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
  return {
    ...recording,
    ledger: overrides.ledger ?? recording.ledger,
    executor,
    controller,
    bodies,
    running,
    approvals,
    opened: opened.promise,
  };
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
it("waits for the durable deadline owner instead of registering an executor timer", async () => {
  const f = fixture();
  try {
    const request = await bounded(f.opened);
    expect(Storage.get().alarms?.get(`${request.requestId}:deadline`)).toMatchObject({
      kind: "at",
      fireAt: request.deadline,
      status: "armed",
    });
    expect(f.approvals.pending()).toHaveLength(1);
    expect(f.bodies).toEqual([]);
  } finally {
    f.controller.abort();
    await bounded(Promise.allSettled([f.running]));
  }
});

it("expires exactly once at the deadline, even with a delayed alarm", async () => {
  let now = 100;
  const f = fixture({ clock: () => now, approvalTimeoutMs: 25 });
  try {
    const request = await bounded(f.opened);
    expect(f.bodies).toEqual([]);
    now = 125;
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    await expect(
      f.approvals.answer({ request: pending, credential: "x", decision: "approve" }),
    ).rejects.toMatchObject({ code: "stale_approval" });
    expect(SessionHandleStore.requestById(pending.id)?.state).toBe("expired");
    await expireApproval(f, request.requestId, now);
    expect((await bounded(f.running))[1]).toEqual({
      terminal: "blocked_pre",
      reason: "approval_timeout",
    });
    await expireApproval(f, request.requestId, now);
    expect(SessionHandleStore.requestById(pending.id)?.state).toBe("expired");
    expect(
      SessionHandleStore.tree(f.identity.sessionId).filter(
        (action) => action.id === `${pending.id}:resolution`,
      ),
    ).toHaveLength(1);
  } finally {
    f.controller.abort();
    await bounded(Promise.allSettled([f.running]));
  }
});
async function expireApproval(f: ReturnType<typeof fixture>, requestId: string, at: number) {
  const result = await f.ledger.transition?.(
    { kind: "request.timeout", requestId },
    `${requestId}:deadline`,
    at,
  );
  if (result?.request !== undefined) f.approvals.notify?.(result.request);
}

it("handles immediate expiry through the durable alarm transition", async () => {
  const f = fixture({ approvalTimeoutMs: 0 });
  const request = await bounded(f.opened);
  await expireApproval(f, request.requestId, 100);
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

it("propagates a failed deadline commit without settling the live suspension", async () => {
  const recording = requestLedger({ id: "deadline-failure" });
  const transition = recording.ledger.transition;
  if (transition === undefined) throw new Error("missing transition");
  const failure = new Error("deadline storage unavailable");
  const opened = Promise.withResolvers<SessionTransition.Request>();
  const f = fixture({
    ...recording,
    approvalTimeoutMs: 0,
    ledger: {
      ...recording.ledger,
      async transition(payload, inputId, at) {
        if (payload.kind === "request.timeout") throw failure;
        const result = await transition(payload, inputId, at);
        if (payload.kind === "request.open") opened.resolve(payload.request);
        return result;
      },
    },
  });
  try {
    const request = await bounded(opened.promise);
    await expect(expireApproval(f, request.requestId, 100)).rejects.toBe(failure);
    expect(f.bodies).toEqual([]);
    expect(f.approvals.pending()).toHaveLength(1);
    expect(SessionHandleStore.requestRows("deadline-failure")[0]?.state).toBe("open");
  } finally {
    f.controller.abort();
    await bounded(Promise.allSettled([f.running]));
  }
});
