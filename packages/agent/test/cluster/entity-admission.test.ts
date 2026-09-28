// W5.1 check4 as a package test (plan §4): the admission and request-transition
// contracts as expected-decision tables against the EXPORTED pure functions
// (parity framing dropped per review F7), plus the real-entity integration
// proofs: C1 single-writer FIFO and A17 whole-backlog drain (F4).
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type SessionTransition,
} from "@openomni/protocol";
import { Effect } from "effect";
import {
  decideRequestTransition,
  decideSessionAdmission,
  requestBindingDigest,
} from "../../src/index";
import { turnIntentAction, turnTerminalAction } from "../../src/session-record";
import {
  readChain,
  runCluster,
  type TestTurnInput,
  type TestTurnRunner,
  sendPrompt,
  sendResume,
  sessionFileFor,
  verifyChain,
} from "../helpers/cluster-runtime";

type AdmissionSnapshot = Parameters<typeof decideSessionAdmission>[0];
type AdmissionDecision = ReturnType<typeof decideSessionAdmission>;
type OpenTurn = NonNullable<AdmissionSnapshot["open"]>;
type TurnTerminal = NonNullable<AdmissionSnapshot["terminal"]>;

// ---------------------------------------------------------------------------
// Shared fixtures (mirrors packages/agent/test/session-fsm.test.ts shapes).
// ---------------------------------------------------------------------------

function sessionRow(state: LedgerSession.State): LedgerSession.Row {
  return {
    id: "S",
    parentId: null,
    role: "resident",
    leaseOwner: "kernel",
    leaseFence: 1,
    leaseExpiresAt: 1000,
    revision: 1,
    state,
    toolsGeneration: 1,
    systemHash: "system",
    policyGeneration: 1,
  };
}

const generation = SessionHandleStore.generationSnapshot({
  generation: 1,
  revertTo: 0,
  tools: [],
  system: { preset: "", blocks: [] },
  policyGeneration: 1,
});

function node(action: LedgerAction.Append): LedgerAction.Node {
  return { ...action, ordinal: 1, prevHash: "prev", actionHash: "hash" };
}

const turn = node(
  turnIntentAction({
    id: "T",
    parentId: null,
    sessionId: "S",
    resultId: "R",
    inboxIds: [],
    generation,
    resumeCount: 0,
    boundaryActionId: null,
    at: 1,
  }),
);

const open: OpenTurn = {
  turnId: "T",
  resultId: "R",
  resumeCount: 0,
  boundaryActionId: null,
  action: turn,
  toolsGeneration: 1,
  toolsHash: generation.toolsHash,
  systemHash: generation.systemHash,
  policyGeneration: 1,
};

function terminal(kind: "result" | "interrupted"): TurnTerminal {
  const action = node(
    turnTerminalAction({
      id: "R",
      parentId: "T",
      sessionId: "S",
      turnId: "T",
      result: { kind, text: "" },
      resumeCount: 0,
      boundaryActionId: null,
      at: 2,
    }),
  );
  const effect = SessionHandleStore.turnTerminal(action);
  if (effect === undefined) throw new Error("invalid terminal fixture");
  return { action, effect };
}

let itemSequence = 0;
function item(kind: Inbox.Kind, sessionId = "S"): Inbox.Row {
  itemSequence += 1;
  return {
    id: `M${itemSequence}`,
    sessionId,
    kind,
    content: kind,
    origin: { encodingVersion: 1, value: { kind: "session", id: sessionId } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: itemSequence,
    ordinal: itemSequence,
  };
}

/** The W1 contract surface: the decision kind plus WHICH items/turn it selects. */
function normalize(decision: AdmissionDecision): { kind: string; ids: readonly string[] } {
  switch (decision.kind) {
    case "recover":
      return { kind: decision.kind, ids: [decision.open.turnId] };
    case "resume":
      return { kind: decision.kind, ids: [decision.item.id] };
    case "consume":
      return { kind: decision.kind, ids: decision.items.map((entry) => entry.id) };
    default:
      return { kind: decision.kind, ids: [] };
  }
}

// ---------------------------------------------------------------------------
// Table A: admission expected-decision rows (A01–A17).
// ---------------------------------------------------------------------------

interface AdmissionCase {
  readonly name: string;
  readonly state: LedgerSession.State;
  readonly items: readonly Inbox.Row[];
  readonly open?: OpenTurn;
  readonly terminal?: TurnTerminal;
  readonly expected: { readonly kind: string; readonly at?: readonly number[] };
}

const prompt = () => item("prompt");
const interrupt = () => item("interrupt");
const resume = () => item("resume");

// `expected.at` indexes into `items` for the ids the decision must select
// (recover selects the open turn "T" instead and is asserted explicitly).
const admissionCases: readonly AdmissionCase[] = [
  { name: "A01 idle + [] -> stop", state: "idle", items: [], expected: { kind: "stop" } },
  {
    name: "A02 idle + [prompt] -> start",
    state: "idle",
    items: [prompt()],
    expected: { kind: "start" },
  },
  {
    name: "A03 idle + [interrupt, prompt] -> consume [interrupt]",
    state: "idle",
    items: [interrupt(), prompt()],
    expected: { kind: "consume", at: [0] },
  },
  {
    name: "A04 idle + [prompt, prompt] -> start (second stays queued)",
    state: "idle",
    items: [prompt(), prompt()],
    expected: { kind: "start" },
  },
  {
    name: "A05 idle + [resume] -> consume [resume]",
    state: "idle",
    items: [resume()],
    expected: { kind: "consume", at: [0] },
  },
  {
    name: "A06 idle + [resume, resume, prompt] -> consume control prefix",
    state: "idle",
    items: [resume(), resume(), prompt()],
    expected: { kind: "consume", at: [0, 1] },
  },
  {
    name: "A07 running + open -> recover",
    state: "running",
    items: [prompt()],
    open,
    expected: { kind: "recover" },
  },
  {
    name: "A08 running without open -> refused",
    state: "running",
    items: [prompt()],
    expected: { kind: "refused" },
  },
  {
    name: "A09 interrupted + [resume] + terminal interrupted -> resume",
    state: "interrupted",
    items: [resume()],
    terminal: terminal("interrupted"),
    expected: { kind: "resume", at: [0] },
  },
  {
    name: "A10 interrupted + [resume] without interrupted terminal -> consume",
    state: "interrupted",
    items: [resume()],
    terminal: terminal("result"),
    expected: { kind: "consume", at: [0] },
  },
  {
    name: "A11 interrupted + [prompt] -> stop",
    state: "interrupted",
    items: [prompt()],
    terminal: terminal("interrupted"),
    expected: { kind: "stop" },
  },
  {
    name: "A12 foreign-session item -> refused",
    state: "idle",
    items: [item("prompt", "other-session")],
    expected: { kind: "refused" },
  },
  {
    name: "A13 foreign open -> refused",
    state: "running",
    items: [],
    open: { ...open, action: { ...turn, sessionId: "other-session" } },
    expected: { kind: "refused" },
  },
  {
    name: "A14 foreign terminal -> refused",
    state: "interrupted",
    items: [resume()],
    terminal: (() => {
      const t = terminal("interrupted");
      return { ...t, action: { ...t.action, sessionId: "other-session" } };
    })(),
    expected: { kind: "refused" },
  },
  {
    name: "A15 idle + own open -> refused",
    state: "idle",
    items: [prompt()],
    open,
    expected: { kind: "refused" },
  },
];

function decide(c: AdmissionCase): AdmissionDecision {
  return decideSessionAdmission({
    row: sessionRow(c.state),
    pending: c.items,
    ...(c.open === undefined ? {} : { open: c.open }),
    ...(c.terminal === undefined ? {} : { terminal: c.terminal }),
  });
}

describe("Table A: admission decisions over the chain-derived pending set", () => {
  for (const c of admissionCases) {
    test(c.name, () => {
      const decision = decide(c);
      expect(decision.kind).toBe(c.expected.kind as AdmissionDecision["kind"]);
      if (c.expected.at !== undefined) {
        const ids = c.expected.at.map((index) => {
          const selected = c.items[index];
          if (selected === undefined) throw new Error(`case ${c.name}: bad index ${index}`);
          return selected.id;
        });
        expect(normalize(decision).ids).toEqual(ids);
      }
      if (decision.kind === "recover") expect(decision.open.turnId).toBe("T");
    });
  }

  test("A16 FIFO invariance (idle): items after the first prompt never change the decision", () => {
    const prefixes: readonly (readonly Inbox.Kind[])[] = [
      ["prompt"],
      ["interrupt", "prompt"],
      ["resume", "prompt"],
      ["interrupt", "resume", "prompt"],
      ["resume", "resume", "prompt"],
    ];
    const suffixes: readonly (readonly Inbox.Kind[])[] = [
      [],
      ["prompt"],
      ["interrupt"],
      ["resume", "prompt"],
      ["interrupt", "interrupt", "prompt"],
    ];
    const row = sessionRow("idle");
    for (const prefix of prefixes) {
      const prefixItems = prefix.map((kind) => item(kind));
      const base = normalize(decideSessionAdmission({ row, pending: prefixItems }));
      for (const suffix of suffixes) {
        const extended = [...prefixItems, ...suffix.map((kind) => item(kind))];
        expect(normalize(decideSessionAdmission({ row, pending: extended }))).toEqual(base);
      }
    }
  });

  test("A17 interrupted scans the WHOLE pending set for resume (not prefix-invariant)", () => {
    const row = sessionRow("interrupted");
    const items = [prompt(), resume()];
    const decision = decideSessionAdmission({
      row,
      pending: items,
      terminal: terminal("interrupted"),
    });
    expect(decision.kind).toBe("resume");
    const second = items[1];
    if (second === undefined || decision.kind !== "resume") throw new Error("fixture");
    expect(decision.item.id).toBe(second.id);
  });
});

// ---------------------------------------------------------------------------
// Table B: request transitions per message in FIFO order (B1–B8).
// ---------------------------------------------------------------------------

const requestRow = sessionRow("running");

function makeRequest(): SessionTransition.Request {
  const parsedInput = { path: "original" };
  const request: SessionTransition.Request = {
    requestId: "invocation",
    sessionId: requestRow.id,
    turnId: "T",
    callId: "call",
    mode: "approval",
    parsedInput,
    inputHash: canonicalDigest(parsedInput),
    effectHash: canonicalDigest({ category: "mutation" }),
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions: {},
    deadline: 100,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
    bindingDigest: "",
  };
  request.bindingDigest = requestBindingDigest(request);
  return request;
}

const invocation: LedgerAction.Node = {
  id: "invocation",
  sessionId: requestRow.id,
  parentId: "T",
  kind: "tool",
  ts: 1,
  ordinal: 1,
  prevHash: "fixture-prev",
  actionHash: "fixture-hash",
  intent: {
    encodingVersion: 1,
    value: {
      phase: "intent",
      op: "write",
      value: { path: "original" },
      effectHash: canonicalDigest({ category: "mutation" }),
    },
  },
  effect: { encodingVersion: 1, value: { phase: "pending" } },
  irreversible: true,
};

function approvalAnswer(
  pending: SessionTransition.Request,
  inputId: string,
  receivedAt: number,
): SessionTransition.Answer {
  return {
    inputId,
    requestId: pending.requestId,
    sessionId: pending.sessionId,
    receivedAt,
    principal: { kind: "owner", principalId: "owner", evidenceId: "authenticated" },
    bindingDigest: pending.bindingDigest,
    inputHash: pending.inputHash,
    effectHash: pending.effectHash,
    generation: pending.generation,
    toolsHash: pending.toolsHash,
    domainRevisions: pending.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "yes",
  };
}

interface RequestItem {
  readonly id: string;
  readonly at: number;
  readonly payload: SessionTransition.Payload;
}

const sealed = makeRequest();

function resolveItem(id: string, at = 20): RequestItem {
  return { id, at, payload: { kind: "request.answer", answer: approvalAnswer(sealed, id, at) } };
}
function cancelItem(id: string, at = 20): RequestItem {
  return {
    id,
    at,
    payload: {
      kind: "request.cancel",
      requestId: sealed.requestId,
      principal: { kind: "owner", principalId: "owner", evidenceId: "authenticated" },
    },
  };
}
function timeoutItem(id: string, at: number): RequestItem {
  return { id, at, payload: { kind: "request.timeout", requestId: sealed.requestId } };
}
function openItem(id: string, at = 20): RequestItem {
  return { id, at, payload: { kind: "request.open", request: makeRequest() } };
}

/** Apply decideRequestTransition per item in the given order, threading state. */
function foldRequestItems(
  items: readonly RequestItem[],
  initial: SessionTransition.Request | undefined,
): { resolutions: readonly SessionTransition.Resolution[]; request?: SessionTransition.Request } {
  let current = initial;
  const resolutions: SessionTransition.Resolution[] = [];
  for (const entry of items) {
    const decision = decideRequestTransition(
      {
        version: 1,
        inputId: entry.id,
        sessionId: requestRow.id,
        at: entry.at,
        expectedRevision: requestRow.revision,
        authority: { owner: "kernel", fence: 1 },
        payload: entry.payload,
      },
      { row: requestRow, invocation, ...(current === undefined ? {} : { request: current }) },
    );
    resolutions.push(decision.resolution);
    if (decision.request !== undefined) current = decision.request;
  }
  return { resolutions, ...(current === undefined ? {} : { request: current }) };
}

interface RequestCase {
  readonly name: string;
  readonly items: readonly RequestItem[];
  readonly initial?: SessionTransition.Request;
  readonly expected: readonly SessionTransition.Resolution[];
  readonly finalState?: SessionTransition.Request["state"];
}

const requestCases: readonly RequestCase[] = [
  {
    name: "B1 [resolve] -> resolved",
    items: [resolveItem("b1-a")],
    initial: makeRequest(),
    expected: ["resolved"],
    finalState: "resolved",
  },
  {
    name: "B2 [resolve, cancel] -> resolved then duplicate (terminal already won)",
    items: [resolveItem("b2-a"), cancelItem("b2-b")],
    initial: makeRequest(),
    expected: ["resolved", "duplicate"],
    finalState: "resolved",
  },
  {
    name: "B3 [cancel, resolve] -> cancelled; later resolve refused-as-duplicate",
    items: [cancelItem("b3-a"), resolveItem("b3-b")],
    initial: makeRequest(),
    expected: ["cancelled", "duplicate"],
    finalState: "cancelled",
  },
  {
    name: "B4 [cancel, timeout] -> cancelled then duplicate",
    items: [cancelItem("b4-a"), timeoutItem("b4-b", 150)],
    initial: makeRequest(),
    expected: ["cancelled", "duplicate"],
    finalState: "cancelled",
  },
  {
    name: "B5 [timeout, resolve] -> expired then late_unknown",
    items: [timeoutItem("b5-a", 150), resolveItem("b5-b", 150)],
    initial: makeRequest(),
    expected: ["expired", "late_unknown"],
    finalState: "expired",
  },
  {
    name: "B6 duplicate resolve -> resolved then duplicate",
    items: [resolveItem("b6-a"), resolveItem("b6-b")],
    initial: makeRequest(),
    expected: ["resolved", "duplicate"],
    finalState: "resolved",
  },
  {
    name: "B7 [open, resolve] -> opened then resolved",
    items: [openItem("b7-a"), resolveItem("b7-b")],
    expected: ["opened", "resolved"],
    finalState: "resolved",
  },
];

describe("Table B: request commands in FIFO order keep the W1 resolutions", () => {
  for (const c of requestCases) {
    test(c.name, () => {
      const fold = foldRequestItems(c.items, c.initial);
      expect(fold.resolutions).toEqual(c.expected);
      if (c.finalState !== undefined) expect(fold.request?.state).toBe(c.finalState);
    });
  }

  test("B8 cancel-first means the resolve never resolves and produces no intake", () => {
    const first = foldRequestItems([cancelItem("b8-a")], makeRequest());
    if (first.request === undefined) throw new Error("cancel must return a request");
    const decision = decideRequestTransition(
      {
        version: 1,
        inputId: "b8-b",
        sessionId: requestRow.id,
        at: 20,
        expectedRevision: 1,
        authority: { owner: "kernel", fence: 1 },
        payload: { kind: "request.answer", answer: approvalAnswer(sealed, "b8-b", 20) },
      },
      { row: requestRow, invocation, request: first.request },
    );
    expect(decision.resolution).not.toBe("resolved");
    expect(decision.resolution).not.toBe("attached");
    expect(decision.receive).toBeUndefined();
    expect(decision.request?.state).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Integration on the real entity: C1 single-writer FIFO + A17 backlog drain.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "w52-entity-admission-"));
const sessionsDir = join(dir, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const catalogFile = join(dir, "catalog.sqlite");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sessionState(file: string): string | undefined {
  const db = new Database(file, { readonly: true });
  try {
    return db.query<{ state: string }, []>("SELECT state FROM session").get()?.state;
  } finally {
    db.close();
  }
}

describe("Integration: entity mailbox is a single writer with whole-backlog drain", () => {
  test("C1 three concurrent prompts serialize: distinct ascending receipts, no handler overlap, linear chain", async () => {
    const spans: { start: number; end: number }[] = [];
    const runner: TestTurnRunner = () =>
      Effect.gen(function* () {
        const start = performance.now();
        // Measured workload (not synchronization): widens the window the
        // no-overlap assertion inspects so interleaving could not hide.
        yield* Effect.sleep(40);
        spans.push({ start, end: performance.now() });
        return { kind: "result" as const, text: "done" };
      });

    const replies = await runCluster(
      { sessionsDir, catalogFile, runner },
      Effect.all(
        [
          sendPrompt("c1", "c1-m1", "one"),
          sendPrompt("c1", "c1-m2", "two"),
          sendPrompt("c1", "c1-m3", "three"),
        ],
        { concurrency: 3 },
      ),
    );

    const ordinals = replies.map((reply) => reply.ordinal);
    expect(new Set(ordinals).size).toBe(3);
    // Single writer: each handler run observed the previous one finished.
    expect(spans).toHaveLength(3);
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) throw new Error("span fixture");
      expect(current.start).toBeGreaterThanOrEqual(previous.end);
    }
    // OUR hash chain stayed linear under concurrency.
    const file = sessionFileFor(sessionsDir, "c1");
    expect(verifyChain(file, "c1")).toBe(readChain(file, "c1").length);
  }, 60_000);

  test("A17 integration: interrupted + backlog [prompt, resume] resumes and leaves the prompt pending (F4)", async () => {
    const calls: TestTurnInput[] = [];
    const runner: TestTurnRunner = (input) =>
      Effect.sync(() => {
        calls.push(input);
        return calls.length === 1
          ? { kind: "interrupted" as const, text: "cut" }
          : { kind: "result" as const, text: "resumed" };
      });

    await runCluster(
      { sessionsDir, catalogFile, runner },
      Effect.gen(function* () {
        yield* sendPrompt("a17", "a17-p1", "first prompt");
        yield* sendPrompt("a17", "a17-p2", "prompt behind the interrupt");
        yield* sendResume("a17", "a17-r1", "resume");
      }),
    );

    // The resume behind the prompt was selected from the WHOLE backlog: the
    // interrupted turn resumed exactly once; the prompt stayed pending.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.resumeCount).toBe(1);
    const file = sessionFileFor(sessionsDir, "a17");
    const chain = readChain(file, "a17");
    expect(chain.filter((row) => row.id === "a17-p2")).toHaveLength(1);
    const db = new Database(file, { readonly: true });
    try {
      const delivered = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM action WHERE kind = 'inbox.deliver' AND intent LIKE ?",
        )
        .get("%a17-p2%");
      expect(delivered?.n ?? 0).toBe(0);
    } finally {
      db.close();
    }
    expect(sessionState(file)).toBe("idle");
  }, 60_000);
});
