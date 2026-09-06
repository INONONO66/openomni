import { expect, it } from "bun:test";
import { canonicalDigest, type LedgerAction } from "@openomni/protocol";
import { createExecutor, type ExecutorOptions } from "../src/executor";
import { compiledPolicy, recordingLedger } from "./helpers/compiled-policy";

const policy = compiledPolicy([{
  name: "approve-write", kind: "tool", phase: "pre",
  match: { encodingVersion: 1, value: { op: "write" } },
  verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
  priority: 1, generation: 1,
}]);
const evidence = { kind: "owner", principalId: "owner-1", evidenceId: "auth-1" } as const;
const request = {
  kind: "tool", op: "write", intent: { path: "approved.txt" }, effect: {},
  toolObservation: { turnId: "turn-1", callId: "call-1" },
};

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("approval event deadline")), 2000);
  })]).finally(() => clearTimeout(timer));
}

function fixture(overrides: Partial<ExecutorOptions> = {}) {
  const recording = recordingLedger();
  const requested = Promise.withResolvers<void>();
  const controller = new AbortController();
  const bodyRecords: LedgerAction.Append[][] = [];
  const executor = createExecutor({
    policy, ledger: recording.ledger,
    identity: {
      sessionId: "session-1", role: "resident", parentActionId: "turn-1", turnId: "turn-1",
      toolsGeneration: 7, toolsHash: "catalog-7",
    },
    clock: () => 100, entropy: recording.entropy,
    authorizeApproval: async () => evidence,
    observations: { publish() {
      const action = recording.committed.at(-1);
      if (action?.kind === "policy.decision" && approvalOp(action) === "request") {
        requested.resolve();
      }
    } },
    ...overrides,
  });
  const approvals = executor.approvals;
  const runBatch = executor.runBatch;
  if (approvals === undefined || runBatch === undefined) throw new Error("missing executor surface");
  const running = runBatch([{ request, async body() {
    bodyRecords.push(structuredClone(recording.committed));
    return { status: "success" };
  } }], { signal: controller.signal });
  return { ...recording, approvals, running, requested: requested.promise, controller, bodyRecords };
}

function approvalOp(action: LedgerAction.Append) {
  const value = action.intent.value;
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    value.phase === "approval" ? value.op : undefined;
}

for (const decision of ["approve", "refuse"] as const) {
  it(`commits authenticated ${decision} before releasing the suspended body`, async () => {
    const authorized: unknown[] = [];
    const f = fixture({ authorizeApproval: async (credential, pending) => {
      authorized.push({ credential, pending });
      return evidence;
    } });
    try {
      await bounded(f.requested);
      const pending = f.approvals.pending()[0];
      if (pending === undefined) throw new Error("missing pending approval");
      expect(f.bodyRecords).toEqual([]);
      expect(pending).toMatchObject({
        sessionId: "session-1", turnId: "turn-1", callId: "call-1",
        toolsGeneration: 7, toolsHash: "catalog-7", generation: 1,
        inputHash: canonicalDigest(request.intent), intent: request.intent,
      });
      const original = structuredClone(pending);
      const snapshot = f.approvals.pending()[0];
      if (snapshot === undefined || snapshot.intent === null || typeof snapshot.intent !== "object") {
        throw new Error("missing object snapshot");
      }
      Object.assign(snapshot.intent, { path: "tampered.txt" });
      expect(f.approvals.pending()).toEqual([original]);
      await f.approvals.answer({ request: pending, credential: "owner-token", decision });
      expect(await bounded(f.running)).toEqual(decision === "approve"
        ? [{ terminal: "executed", value: { status: "success" } }]
        : [{ terminal: "blocked_pre", reason: "approval_refused" }]);
      expect(authorized).toEqual([{ credential: "owner-token", pending }]);
      const answers = f.committed.filter((action) => approvalOp(action) === "answer");
      expect(answers).toHaveLength(1);
      const answer = answers[0];
      if (answer === undefined) throw new Error("missing durable answer");
      expect(answer).toMatchObject({
        parentId: pending.id, sessionId: pending.sessionId,
        effect: { value: { decision, evidence, request: pending } },
      });
      expect(f.bodyRecords).toEqual(decision === "approve"
        ? [f.committed.slice(0, f.committed.indexOf(answer) + 1)] : []);
      expect(f.approvals.pending()).toEqual([]);
      await expect(f.approvals.answer({ request: pending, credential: "owner-token", decision }))
        .rejects.toMatchObject({ code: "stale_approval" });
    } finally {
      f.controller.abort();
      await bounded(f.running);
    }
  });
}

it("rejects forged requests and unavailable approval authority without releasing the body", async () => {
  const f = fixture({ authorizeApproval: undefined });
  try {
    await bounded(f.requested);
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    await expect(f.approvals.answer({
      request: { ...pending, toolsHash: "other-catalog" }, decision: "approve", credential: "token",
    })).rejects.toMatchObject({ code: "stale_approval" });
    await expect(f.approvals.answer({ request: pending, decision: "approve", credential: "token" }))
      .rejects.toMatchObject({ code: "approval_authority_unavailable" });
    f.controller.abort();
    expect(await bounded(f.running)).toEqual([{ terminal: "cancelled" }]);
    expect(f.bodyRecords).toEqual([]);
    expect(f.committed.filter((action) => approvalOp(action) === "answer")).toEqual([]);
    expect(f.approvals.pending()).toEqual([]);
  } finally {
    f.controller.abort();
    await bounded(f.running);
  }
});

it("rechecks cancellation after asynchronous owner authorization", async () => {
  const authorizing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<typeof evidence>();
  const f = fixture({ authorizeApproval() { authorizing.resolve(); return release.promise; } });
  let answering: Promise<void> | undefined;
  try {
    await bounded(f.requested);
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    answering = f.approvals.answer({ request: pending, decision: "approve", credential: "token" });
    // Attach the rejection observer before cancellation/authorization settlement.
    const settled = Promise.allSettled([answering]);
    await bounded(authorizing.promise);
    f.controller.abort();
    await bounded(f.running);
    release.resolve(evidence);
    expect(await bounded(settled)).toMatchObject([
      { status: "rejected", reason: { code: "stale_approval" } },
    ]);
    expect(f.bodyRecords).toEqual([]);
    expect(f.committed.filter((action) => approvalOp(action) === "answer")).toEqual([]);
    expect(f.approvals.pending()).toEqual([]);
  } finally {
    f.controller.abort();
    release.resolve(evidence);
    await bounded(Promise.allSettled([f.running, ...(answering ? [answering] : [])]));
  }
});

it("records expiry once at the deadline and cancels its scheduled callback", async () => {
  let now = 100;
  let cancelled = 0;
  const scheduled = Promise.withResolvers<{ expire: () => void; delay: number }>();
  const f = fixture({
    clock: () => now, approvalTimeoutMs: 25,
    scheduleApprovalTimeout(expire, delay) {
      scheduled.resolve({ expire, delay });
      return () => { cancelled += 1; };
    },
  });
  try {
    const { expire, delay } = await bounded(scheduled.promise);
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    expect(delay).toBe(25);
    expect(pending.expiresAt).toBe(125);
    expire(); // An early callback is not authority to expire the request.
    expect(f.committed.filter((action) => approvalOp(action) === "timeout")).toEqual([]);
    expect(f.approvals.pending()).toEqual([pending]);
    now = 125;
    await expect(f.approvals.answer({ request: pending, decision: "approve", credential: "token" }))
      .rejects.toMatchObject({ code: "stale_approval" });
    expire();
    expect(await bounded(f.running)).toEqual([{ terminal: "blocked_pre", reason: "approval_timeout" }]);
    expire(); // Stale scheduler delivery after cleanup must be inert.
    const timeouts = f.committed.filter((action) => approvalOp(action) === "timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({ parentId: pending.id, ts: 125, effect: { value: {
      decision: "timeout", request: pending,
      evidence: { kind: "deadline", at: 125, expiresAt: 125 },
    } } });
    expect(f.bodyRecords).toEqual([]);
    expect(f.approvals.pending()).toEqual([]);
    expect(cancelled).toBe(1);
  } finally {
    f.controller.abort();
    await bounded(f.running);
  }
});

it("uses the native timer for an immediate approval deadline", async () => {
  const f = fixture({ approvalTimeoutMs: 0 });
  try {
    expect(await bounded(f.running)).toEqual([{ terminal: "blocked_pre", reason: "approval_timeout" }]);
    expect(f.bodyRecords).toEqual([]);
    expect(f.approvals.pending()).toEqual([]);
  } finally {
    f.controller.abort();
    await bounded(f.running);
  }
});

it("propagates a failed deadline commit and clears the suspended approval", async () => {
  const recording = recordingLedger();
  const failure = new Error("ledger unavailable");
  const scheduled = Promise.withResolvers<() => void>();
  let cancelled = 0;
  const f = fixture({
    approvalTimeoutMs: 0, entropy: recording.entropy,
    ledger: { async commit(action) {
      if (approvalOp(action) === "timeout") throw failure;
      return recording.ledger.commit(action);
    } },
    scheduleApprovalTimeout(expire) {
      scheduled.resolve(expire);
      return () => { cancelled += 1; };
    },
  });
  const settled = Promise.allSettled([f.running]);
  try {
    const expire = await bounded(scheduled.promise);
    expire();
    expect(await bounded(settled)).toEqual([{ status: "rejected", reason: failure }]);
    expect(f.bodyRecords).toEqual([]);
    expect(f.approvals.pending()).toEqual([]);
    expect(cancelled).toBe(1);
  } finally {
    f.controller.abort();
    await bounded(settled);
  }
});

it("rejects invalid approval deadlines before admitting execution", () => {
  const recording = recordingLedger();
  for (const approvalTimeoutMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => createExecutor({
      policy, ledger: recording.ledger, observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      clock: () => 100, entropy: recording.entropy, approvalTimeoutMs,
    })).toThrow(TypeError);
  }
});
