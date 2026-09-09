import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runChatAttempts } from "./helpers/chat-attempts";
import { seedPolicy } from "./helpers/seed-policy";
import { answerThenCompact } from "./helpers/answer-then-compact";
import { approveWriteRow } from "./helpers/compiled-policy";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Run } from "@openomni/llm";
import { Alarm, L0Observation, type PolicyRow, type SessionHistory } from "@openomni/protocol";
import {
  Bus,
  closeSessions,
  createTurnDispatcher,
  foldSessionHistory,
  inspectActions,
  inspectPolicy,
  session,
  wakeSession,
  type SessionHandle,
  type SessionRunner,
  type SessionRuntime,
} from "../src/index";
import { bounded } from "./helpers/bounded";

const SECRET = "sk-live-credential-never-shown";
let nextId = 0;
let bodies = 0;
const runtime: SessionRuntime = {
  observations: Bus,
  clock: () => 1_000,
  entropy: () => `inspect-id-${++nextId}`,
  processId: "inspection-test",
  scheduleHeartbeat: () => () => undefined,
  waitRetry: async () => undefined,
  authorizeApproval: async () => ({ kind: "owner", principalId: "owner", evidenceId: "auth-1" }),
  async dispatchOutbound({ message }) {
    const received = SessionHandleStore.commitReceivedMessage({
      id: message.messageId,
      sessionId: message.destinationSessionId,
      kind: "prompt",
      content: message.content,
      origin: { encodingVersion: 1, value: message },
      createdAt: 1_000,
      parentActionId: null,
    });
    await wakeSession(message.destinationSessionId, parentRunner, runtime);
    return received.receipt;
  },
};

const rows: readonly Omit<PolicyRow.Row, "generation">[] = [
  {
    name: "refuse-forbidden",
    kind: "tool",
    phase: "pre",
    match: { encodingVersion: 1, value: { op: "forbidden" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "not_allowed" } },
    priority: 1,
  },
  approveWriteRow,
];

function providerFailure(): Run.Failure {
  return new Run.FailureError(
    {
      message: "overloaded",
      aborted: false,
      contextOverflow: false,
      visibleOutput: false,
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    { cause: Object.assign(new Error("overloaded"), { isRetryable: true, statusCode: 529 }) },
  );
}

/** Waits for the next committed action of `kind` in `sessionId`, subscribed before the trigger. */
function committed(sessionId: string, kind: string): Promise<L0Observation.ActionCommitted> {
  return new Promise((resolve) => {
    const stop = Bus.subscribe(
      L0Observation.ActionCommittedEvent,
      (event) => {
        if (event.kind !== kind) return;
        stop();
        resolve(event);
      },
      { match: { sessionId } },
    );
  });
}

/**
 * One real turn: a retried model call, a refused tool, an approved tool carrying a
 * credential, an effect whose outcome is unknown, an answer, and a compaction.
 */
const parentRunner: SessionRunner = async (input) => {
  if (input.messages.at(-1)?.text !== "hello") return { kind: "result", text: "noted" };
  const { executor } = createTurnDispatcher([], input, runtime);
  let calls = 0;
  await runChatAttempts(executor, async () => {
    calls += 1;
    bodies += 1;
    if (calls === 1) throw providerFailure();
    return { type: "stop" };
  });
  const opened = committed(input.sessionId, "request");
  const wave = executor.runBatch(
    [
      {
        request: {
          kind: "tool",
          op: "forbidden",
          intent: { path: "/etc/shadow" },
          effect: { category: "mutation" },
          toolObservation: { turnId: input.turnId, callId: "call-forbidden" },
        },
        async body() {
          bodies += 1;
          return {};
        },
      },
      {
        request: {
          kind: "tool",
          op: "write",
          intent: { path: "approved.txt", apiKey: SECRET },
          effect: { category: "mutation" },
          toolObservation: { turnId: input.turnId, callId: "call-write" },
        },
        async body() {
          bodies += 1;
          return { status: "success" };
        },
      },
    ],
    { signal: new AbortController().signal },
  );
  await bounded(opened);
  const approvals = executor.approvals;
  const pending = approvals?.pending()[0];
  if (approvals === undefined || pending === undefined) throw new Error("approval never opened");
  await approvals.answer({ request: pending, credential: "owner", decision: "approve" });
  await wave;
  const [unknown] = await executor.runBatch(
    [
      {
        request: {
          kind: "tool",
          op: "webhook",
          intent: { url: "https://example.test" },
          effect: { category: "mutation" },
          toolObservation: { turnId: input.turnId, callId: "call-webhook" },
        },
        async body() {
          bodies += 1;
          throw new Error("outcome_unknown");
        },
      },
    ],
    { signal: new AbortController().signal },
  );
  if (unknown?.terminal !== "failed") throw new Error("webhook settlement must be uncertain");
  return answerThenCompact(executor, input);
};

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  nextId = 0;
  bodies = 0;
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
  seedPolicy(rows);
});

afterEach(async () => {
  await closeSessions(runtime);
  Storage.reset();
  Bus.reset();
});

/** Parent turn, commissioned child whose answer wakes the parent, then a monitor wake. */
async function lifecycle(): Promise<SessionHandle> {
  const parent = session({ id: "parent", role: "resident", runner: parentRunner }, runtime);
  await parent.prompt("hello");
  const child = session(
    {
      id: "child",
      parentId: "parent",
      role: "worker",
      runner: async () => ({ kind: "result", text: "child answer" }),
    },
    runtime,
  );
  const commission = SessionHandleStore.tree("parent").find(
    (action) => SessionHandleStore.turnTerminal(action) !== undefined,
  );
  if (commission === undefined) throw new Error("parent turn never sealed");
  await child.prompt("work", {
    encodingVersion: 1,
    value: {
      kind: "message",
      messageId: "commission",
      senderSessionId: "parent",
      sourceActionId: commission.id,
    },
  });
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("missing alarm adapter");
  alarms.arm({ id: "monitor", sessionId: "parent", kind: "at", fireAt: 1_000 });
  const owned = alarms.acquire("monitor", 0);
  if (owned === undefined) throw new Error("alarm acquisition refused");
  const woke = committed("parent", "turn");
  alarms.fire({
    id: "monitor",
    epoch: 1,
    fence: owned.fence,
    sourceKey: `timer:${owned.fireAt}`,
    at: 1_000,
    content: "monitor woke",
    terminal: true,
  });
  await wakeSession("parent", parentRunner, runtime);
  await bounded(woke);
  return parent;
}

describe("action-based history and diagnostic projections", () => {
  test("every transition of a request spanning child, retry, refusal, approval, wake and compaction traces to a committed cause", async () => {
    const parent = await lifecycle();
    const inspection = parent.inspect({ depth: 1 });
    const tree = SessionHandleStore.tree("parent");
    expect(inspection.transitions.map((entry) => entry.actionId)).toEqual(tree.map((a) => a.id));
    expect(inspection.transitions.map((entry) => entry.revision)).toEqual(
      tree.map((action) => action.ordinal),
    );
    const known = new Set(tree.map((action) => action.id));
    const inbox = new Set(SessionHandleStore.inboxRows("parent").map((row) => row.id));
    for (const transition of inspection.transitions) {
      switch (transition.cause.kind) {
        case "action":
          expect(known.has(transition.cause.actionId)).toBe(true);
          break;
        case "inbox":
          for (const id of transition.cause.inboxIds) expect(inbox.has(id)).toBe(true);
          break;
        case "alarm":
          expect(transition.cause).toEqual({ kind: "alarm", alarmId: "monitor", epoch: 1 });
          break;
        case "root":
          expect(transition.parentId).toBeNull();
          expect(["session.configure", "alarm.arm"]).toContain(transition.kind);
          break;
        default:
          throw new Error("unreachable cause");
      }
    }
    const byOp = (op: string, phase: SessionHistory.Phase) =>
      inspection.transitions.filter((entry) => entry.op === op && entry.phase === phase);
    expect(byOp("chat", "intent").filter((entry) => entry.kind === "attempt")).toHaveLength(2);
    expect(byOp("chat", "result").map((entry) => entry.outcome)).toEqual([
      "failed",
      "executed",
      "executed",
    ]);
    expect(byOp("forbidden", "intent")).toEqual([]);
    expect(byOp("forbidden", "decision").map((entry) => [entry.outcome, entry.reason])).toEqual([
      ["blocked_pre", "not_allowed"],
    ]);
    expect(byOp("write", "result").map((entry) => entry.outcome)).toEqual(["executed"]);
    expect(byOp("webhook", "result").map((entry) => entry.outcome)).toEqual(["outcome_unknown"]);
    expect(inspection.requests).toMatchObject([
      { mode: "approval", callId: "call-write", state: "resolved", outcome: "executed" },
    ]);
    expect(inspection.compactions).toHaveLength(1);
    expect(inspection.compactions[0]?.discarded.count).toBeGreaterThan(0);
    expect(inspection.compactions[0]?.restoredBy).toEqual([]);
    const woke = inspection.transitions.filter((entry) => entry.cause.kind === "alarm");
    expect(woke.map((entry) => entry.kind)).toEqual(["alarm.fired"]);
    const monitorFire = Alarm.occurrenceId("monitor", 1, "timer:1000");
    expect(woke.map((entry) => entry.actionId)).toEqual([monitorFire]);
    const wakePrompt = inspection.transitions.find(
      (entry) => entry.kind === "prompt" && entry.parentId === monitorFire,
    );
    expect(wakePrompt?.cause).toEqual({ kind: "action", actionId: monitorFire });
    const fromChild = inspection.transitions.find(
      (entry) => entry.kind === "prompt" && entry.peerSessionId === "child",
    );
    expect(inspection.children.map((child) => child.sessionId)).toEqual(["child"]);
    const outbound = inspection.children[0]?.transitions.filter((e) => e.kind === "outbound");
    expect(outbound?.map((entry) => [entry.peerSessionId, entry.outcome])).toEqual([
      ["parent", "pending"],
      ["parent", "executed"],
    ]);
    const obligation = SessionHandleStore.outboundRows("child")[0];
    expect(fromChild?.actionId).toBe(obligation?.message.messageId ?? "");
    expect(fromChild?.cause).toEqual({ kind: "inbox", inboxIds: [fromChild?.actionId ?? ""] });
    expect(inspection.children[0]?.children).toEqual([]);
    expect(parent.inspect({ depth: 0 }).children).toEqual([]);
  });

  test("policy decisions are inspectable by generation, rule and verdict and never carry payloads", async () => {
    const parent = await lifecycle();
    const inspection = parent.inspect();
    expect(inspectPolicy(inspection.policy, { verdict: "deny" })).toMatchObject([
      { op: "forbidden", hook: "tool.pre", matchedRuleIds: ["refuse-forbidden"] },
    ]);
    expect(inspectPolicy(inspection.policy, { ruleId: "approve-write" })).toMatchObject([
      { verdict: "require_approval", reason: "owner", generation: 1 },
    ]);
    expect(inspectPolicy(inspection.policy, { generation: 2 })).toEqual([]);
    expect(inspectPolicy(inspection.policy, { generation: 1 })).toEqual([...inspection.policy]);
    for (const decision of inspection.policy) {
      if (decision.subjectActionId === null) continue;
      expect(inspection.transitions.some((e) => e.actionId === decision.subjectActionId)).toBe(
        true,
      );
    }
    const rendered = JSON.stringify(inspection);
    expect(JSON.stringify(SessionHandleStore.tree("parent"))).toContain(SECRET);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain("/etc/shadow");
  });

  test("inspection and history are pure reads: no body runs and no action is appended", async () => {
    const parent = await lifecycle();
    const before = SessionHandleStore.tree("parent");
    const ran = bodies;
    parent.inspect({ depth: 2 });
    parent.history({ limit: 5 });
    inspectActions("parent", null, before);
    expect(bodies).toBe(ran);
    expect(SessionHandleStore.tree("parent")).toEqual(before);
    expect(SessionHandleStore.tree("child")).toEqual(SessionHandleStore.tree("child"));
  });

  test("a materialized tail rebuilt from bounded pages equals the canonical fold", async () => {
    const parent = await lifecycle();
    const before = SessionHandleStore.tree("parent");
    const rebuilt: typeof before = [];
    let page = parent.history({ afterRevision: 0, limit: 4 });
    for (;;) {
      expect(page.actions.length).toBeLessThanOrEqual(4);
      rebuilt.push(...page.actions);
      if (page.nextRevision === null) break;
      page = parent.history({ afterRevision: page.nextRevision, limit: 4 });
    }
    expect(page.headRevision).toBe(parent.get().revision);
    expect(rebuilt).toEqual(before);
    const { children, ...canonical } = parent.inspect({ depth: 0 });
    expect(children).toEqual([]);
    expect(inspectActions("parent", null, rebuilt)).toEqual(canonical);
    expect(foldSessionHistory("parent", rebuilt)).toEqual(foldSessionHistory("parent", before));
  });
});
