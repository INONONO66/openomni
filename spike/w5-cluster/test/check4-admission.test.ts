// Check 4: the cluster entity mailbox (FIFO, single writer per entity) composed
// with the pure decideSessionAdmission keeps the W1 admission contract — the
// decisions equal what the current inbox-table path produces for the same
// sequences — and decideRequestTransition applied per mailbox item in FIFO
// order yields the same resolutions the inbox path yields for the same order.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/cluster";
import { Rpc } from "effect/rpc";
import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type SessionTransition,
} from "@openomni/protocol";
// SPIKE-ONLY deep imports (pure decision modules and record builders are not on
// the @openomni/agent public surface; see admission-bridge.ts for the same note).
import { decideSessionAdmission } from "../../../packages/agent/src/session-admission";
import {
  decideRequestTransition,
  requestBindingDigest,
} from "../../../packages/agent/src/session-request";
import { turnIntentAction, turnTerminalAction } from "../../../packages/agent/src/session-record";
import {
  decideFromMailbox,
  type AdmissionDecision,
  type MailboxItem,
  type OpenTurn,
  type TurnTerminal,
} from "../src/admission-bridge.ts";
import { makeRuntime } from "../src/runtime.ts";
import { SPIKE_FENCE, SPIKE_OWNER, sendPrompt } from "../src/session-entity.ts";
import {
  appendTurnAction,
  ensureSessionRow,
  fileFor,
  openSessionDb,
  readChain,
} from "../src/session-file.ts";

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
function item(kind: Inbox.Kind, sessionId = "S"): MailboxItem {
  itemSequence += 1;
  return { id: `M${itemSequence}`, sessionId, kind, content: kind, receivedAt: itemSequence };
}

/**
 * The CURRENT inbox-table path: pending Inbox.Rows as the table returns them
 * (status pending, table ordinals in arrival order) fed to decideSessionAdmission.
 * Built independently of mailboxToPending so parity is not circular.
 */
function inboxRows(items: readonly MailboxItem[]): readonly Inbox.Row[] {
  return items.map((entry, index) => ({
    id: entry.id,
    sessionId: entry.sessionId,
    kind: entry.kind,
    content: entry.content,
    origin: { encodingVersion: 1, value: { kind: "session", id: entry.sessionId } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: entry.receivedAt,
    ordinal: index + 1,
  }));
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
// Table A: admission parity, mailbox plane vs inbox-table plane.
// ---------------------------------------------------------------------------

interface AdmissionCase {
  readonly name: string;
  readonly state: LedgerSession.State;
  readonly items: readonly MailboxItem[];
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

describe("Table A: mailbox admission equals the inbox-table admission", () => {
  for (const c of admissionCases) {
    test(c.name, () => {
      const row = sessionRow(c.state);
      const mailboxDecision = decideFromMailbox(row, c.items, c.open, c.terminal);
      const inboxDecision = decideSessionAdmission({
        row,
        pending: inboxRows(c.items),
        ...(c.open === undefined ? {} : { open: c.open }),
        ...(c.terminal === undefined ? {} : { terminal: c.terminal }),
      });
      // Parity: both planes select the same decision and the same items.
      expect(normalize(mailboxDecision)).toEqual(normalize(inboxDecision));
      // Expected contract row.
      expect(mailboxDecision.kind).toBe(c.expected.kind as AdmissionDecision["kind"]);
      if (c.expected.at !== undefined) {
        const ids = c.expected.at.map((index) => {
          const selected = c.items[index];
          if (selected === undefined) throw new Error(`case ${c.name}: bad index ${index}`);
          return selected.id;
        });
        expect(normalize(mailboxDecision).ids).toEqual(ids);
      }
      if (mailboxDecision.kind === "recover") expect(mailboxDecision.open.turnId).toBe("T");
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
      const base = normalize(decideFromMailbox(row, prefixItems));
      for (const suffix of suffixes) {
        const extended = [...prefixItems, ...suffix.map((kind) => item(kind))];
        expect(normalize(decideFromMailbox(row, extended))).toEqual(base);
      }
    }
  });

  test("A17 interrupted scans the whole mailbox for resume — identical on both planes", () => {
    // NOT prefix-invariant by design: a resume behind a prompt is still found.
    // Parity holds because both planes run the same scan over the same rows.
    const row = sessionRow("interrupted");
    const items = [prompt(), resume()];
    const mailboxDecision = decideFromMailbox(row, items, undefined, terminal("interrupted"));
    const inboxDecision = decideSessionAdmission({
      row,
      pending: inboxRows(items),
      terminal: terminal("interrupted"),
    });
    expect(normalize(mailboxDecision)).toEqual(normalize(inboxDecision));
    expect(mailboxDecision.kind).toBe("resume");
    const second = items[1];
    if (second === undefined || mailboxDecision.kind !== "resume") throw new Error("fixture");
    expect(mailboxDecision.item.id).toBe(second.id);
  });
});

// ---------------------------------------------------------------------------
// Table B: request transitions (decideRequestTransition) per mailbox item in
// FIFO order equal the inbox path for the same order.
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

/** One request command as it would sit in the entity mailbox / inbox table. */
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

/** The inbox path: rows with table ordinals, drained sorted by ordinal. */
function foldInboxOrder(
  items: readonly RequestItem[],
  initial: SessionTransition.Request | undefined,
): readonly SessionTransition.Resolution[] {
  const rows = items.map((entry, index) => ({ ordinal: index + 1, entry }));
  // Present them shuffled: the table sort by ordinal must restore arrival order.
  const shuffled = [...rows].reverse().sort((a, b) => a.ordinal - b.ordinal);
  return foldRequestItems(
    shuffled.map((row) => row.entry),
    initial,
  ).resolutions;
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
    name: "B3 [cancel, resolve] -> cancelled; later resolve is refused-as-duplicate, never applied",
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

describe("Table B: request commands in mailbox FIFO order equal the inbox order", () => {
  for (const c of requestCases) {
    test(c.name, () => {
      const mailbox = foldRequestItems(c.items, c.initial);
      expect(mailbox.resolutions).toEqual(c.expected);
      expect(foldInboxOrder(c.items, c.initial)).toEqual(c.expected);
      if (c.finalState !== undefined) expect(mailbox.request?.state).toBe(c.finalState);
    });
  }

  test("B8 cancel-first means the resolve never resolves and produces no inbox intake", () => {
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
// Integration: single-writer FIFO proof on the real cluster runtime.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "w5-check4-"));
const root = join(dir, "sessions");
mkdirSync(root, { recursive: true });
const catalogFile = join(dir, "catalog.sqlite");

interface HandlerSpan {
  readonly start: number;
  readonly end: number;
  readonly ordinal: number;
}
const spans: HandlerSpan[] = [];

const ProbePrompt = Rpc.make("Prompt", {
  payload: { text: Schema.String },
  success: Schema.Struct({ ordinal: Schema.Number, actionHash: Schema.String }),
}).annotate(ClusterSchema.Persisted, true);

const ProbeEntity = Entity.make("Check4Session", [ProbePrompt]);

/** Instrumented copy of the Session entity handler: records start/end spans. */
const ProbeLayer = ProbeEntity.toLayer(
  Effect.gen(function* () {
    const address = yield* Entity.CurrentAddress;
    const sessionId: string = address.entityId;
    const db = openSessionDb(fileFor(root, sessionId));
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    ensureSessionRow(db, sessionId, SPIKE_OWNER, SPIKE_FENCE);
    return {
      Prompt: (envelope: Entity.Request<typeof ProbePrompt>) =>
        Effect.gen(function* () {
          const start = performance.now();
          const row = ensureSessionRow(db, sessionId, SPIKE_OWNER, SPIKE_FENCE);
          const result = appendTurnAction(db, {
            sessionId,
            owner: SPIKE_OWNER,
            fence: SPIKE_FENCE,
            expectedRevision: row.revision,
            payload: { text: envelope.payload.text },
          });
          // Measured workload (not synchronization): it widens the window the
          // no-overlap assertion inspects, so interleaving could not hide.
          yield* Effect.sleep(Duration.millis(40));
          spans.push({ start, end: performance.now(), ordinal: result.ordinal });
          return { ordinal: result.ordinal, actionHash: result.actionHash };
        }),
    };
  }),
);

const runtime = ManagedRuntime.make(
  ProbeLayer.pipe(Layer.provideMerge(makeRuntime({ root, catalogFile }))),
);

afterAll(async () => {
  await runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const sendProbe = (sessionId: string, text: string) =>
  Effect.gen(function* () {
    const makeClient = yield* ProbeEntity.client;
    return yield* makeClient(sessionId).Prompt({ text });
  });

describe("Integration: entity mailbox is FIFO with one writer per session", () => {
  test("C1 three concurrent prompts serialize: ordinals 1,2,3 and no handler overlap", async () => {
    const replies = await runtime.runPromise(
      Effect.all([sendProbe("c4", "one"), sendProbe("c4", "two"), sendProbe("c4", "three")], {
        concurrency: 3,
      }),
    );
    expect([...replies.map((reply) => reply.ordinal)].sort((a, b) => a - b)).toEqual([1, 2, 3]);

    expect(spans).toHaveLength(3);
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    // Single writer: each handler run observed the previous one finished.
    expect(ordered.map((span) => span.ordinal)).toEqual([1, 2, 3]);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) throw new Error("span fixture");
      expect(current.start).toBeGreaterThanOrEqual(previous.end);
    }
    console.log(
      `check4 FIFO spans: ${JSON.stringify(
        ordered.map((span) => ({
          ordinal: span.ordinal,
          start: Number(span.start.toFixed(3)),
          end: Number(span.end.toFixed(3)),
        })),
      )}`,
    );

    // OUR hash chain stayed linear under concurrency (prev_hash linkage).
    const db = new Database(fileFor(root, "c4"), { readonly: true });
    try {
      const chain = readChain(db, "c4");
      expect(chain.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
      expect(chain[1]?.prev_hash).toBe(chain[0]?.action_hash ?? "");
      expect(chain[2]?.prev_hash).toBe(chain[1]?.action_hash ?? "");
    } finally {
      db.close();
    }
  });

  test("C2 the unmodified Session entity also serializes three concurrent prompts", async () => {
    const replies = await runtime.runPromise(
      Effect.all(
        [
          sendPrompt("c4-plain", "one"),
          sendPrompt("c4-plain", "two"),
          sendPrompt("c4-plain", "three"),
        ],
        { concurrency: 3 },
      ),
    );
    expect([...replies.map((reply) => reply.ordinal)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
