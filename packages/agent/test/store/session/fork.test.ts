import { Effect, Result } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Inbox, LedgerAction } from "@openomni/protocol";
import { runLedgerSync } from "../helpers/effect";
import { useMemoryStores, testNow } from "../helpers/storage";
import { adoptWriter, materializeSession } from "../helpers/session";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { openSessionStore, SESSION_FILE_SCHEMA_VERSION } from "../../../src/core/store/session-file";
import { deliveryActions, receivedMessageAction, turnTerminalAction } from "../../../src/core/commit";
import { armAction } from "../../../src/core/alarm";
import { forkSession, type ForkPorts, ForkRefused, type ForkReceipt } from "../../../src/core/fork";
import type { LedgerError } from "../../../src/core/store/errors";

const PARENT = "parent";
const CHILD = "child";

const stores = useMemoryStores();

type ChildStore = ReturnType<typeof openSessionStore>;
let childStore: ChildStore | undefined;

beforeEach(() => {
  childStore = openSessionStore(":memory:", { now: testNow });
});

afterEach(() => {
  childStore?.close();
  childStore = undefined;
});

function child(): ChildStore {
  if (childStore === undefined) throw new Error("child store only exists inside a test");
  return childStore;
}

function commit(
  authority: { sessionId: string; owner: string; fence: number },
  actions: readonly LedgerAction.Append[],
) {
  return Result.getOrThrowWith(
    runLedgerSync(
      Effect.result(
        stores.kernel.commit({
          sessionId: authority.sessionId,
          owner: authority.owner,
          fence: authority.fence,
          now: 12,
          expectedRevision: stores.kernel.row(authority.sessionId).revision,
          actions: [...actions],
          state: "idle",
        }),
      ),
    ),
    (error) => error,
  );
}

function inboxRow(id: string, content: string, createdAt: number): Inbox.Row {
  return {
    id,
    sessionId: PARENT,
    kind: "prompt",
    content,
    origin: { encodingVersion: 1, value: { source: "test" } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt,
    ordinal: 1,
  };
}

/**
 * Parent chain: genesis configure, input msg-1, its delivery into turn-1, the
 * turn terminal, an armed alarm, and a pending input msg-2.
 */
function buildParent() {
  materializeSession(stores.kernel, PARENT);
  const authority = adoptWriter(stores.kernel, PARENT, "writer");
  const input = receivedMessageAction({
    id: "msg-1",
    sessionId: PARENT,
    kind: "prompt",
    content: "first",
    origin: { encodingVersion: 1, value: { source: "test" } },
    parentActionId: `${PARENT}:configure`,
    at: 2,
  });
  const [delivery] = deliveryActions(
    [inboxRow("msg-1", "first", 2)],
    { kind: "turn", turnId: "turn-1" },
    { boundaryActionId: null, pendingTotal: 1, delivered: 1, remaining: 0 },
    input.id,
  );
  if (delivery === undefined) throw new Error("delivery action missing");
  const terminal = turnTerminalAction({
    id: "turn-1:terminal",
    parentId: delivery.id,
    sessionId: PARENT,
    turnId: "turn-1",
    result: { kind: "result", text: "done" },
    resumeCount: 0,
    boundaryActionId: null,
    at: 3,
  });
  const arm = armAction({
    parentId: terminal.id,
    sessionId: PARENT,
    purpose: "cron",
    at: 9_000,
    supersedes: null,
    alarmId: "alarm-1",
    sourceKey: "cron:alarm-1",
    payload: {},
    armSeq: 1,
    ts: 4,
  }).action;
  const pending = receivedMessageAction({
    id: "msg-2",
    sessionId: PARENT,
    kind: "prompt",
    content: "second",
    origin: { encodingVersion: 1, value: { source: "test" } },
    parentActionId: arm.id,
    at: 5,
  });
  commit(authority, [input, delivery, terminal, arm, pending]);
  const nodes = stores.kernel.historyPage(PARENT, { afterRevision: 0, limit: 50 }).actions;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hashOf = (id: string): string => {
    const node = byId.get(id);
    if (node === undefined) throw new Error(`missing parent node ${id}`);
    return node.actionHash;
  };
  return { authority, hashOf, head: stores.kernel.verifyChain(PARENT).head };
}

function ports(overrides: Partial<ForkPorts> = {}): ForkPorts {
  return {
    parent: stores.kernel,
    parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION,
    openChild: () => child(),
    indexSession: (input) => stores.catalog.indexSession(input),
    ...overrides,
  };
}

function fork(
  anchor: string,
  overrides: Partial<ForkPorts> = {},
  input: { byteCap?: number; childId?: string } = {},
): Result.Result<ForkReceipt, ForkRefused | LedgerError> {
  return runLedgerSync(
    Effect.result(
      forkSession(ports(overrides), {
        from: PARENT,
        at: anchor,
        childId: input.childId ?? CHILD,
        genesisActionId: `${input.childId ?? CHILD}:genesis`,
        now: 100,
        ...(input.byteCap === undefined ? {} : { byteCap: input.byteCap }),
      }),
    ),
  );
}

function refusalOf(result: Result.Result<ForkReceipt, ForkRefused | LedgerError>): ForkRefused {
  const error = Result.isFailure(result) ? result.failure : undefined;
  if (!(error instanceof ForkRefused)) throw new Error(`expected ForkRefused, got ${String(error)}`);
  return error;
}

describe("Session.fork", () => {
  test("forks at a turn terminal into an independently verifiable child chain", () => {
    const parent = buildParent();
    const receipt = Result.getOrThrowWith(fork(parent.hashOf("turn-1:terminal")), (error) => error);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    // The child chain verifies on its own hashes, with its own head.
    const verdict = childKernel.verifyChain(CHILD);
    expect(verdict.kind).toBe("intact");
    expect(verdict.head).toBe(receipt.head);
    expect(verdict.head).not.toBe(parent.head);

    // Genesis pins the parent, the anchor, its ordinal and the parent head.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    const genesis = nodes[0];
    if (genesis === undefined) throw new Error("child genesis missing");
    expect(genesis.kind).toBe("session.configure");
    expect(genesis.parentId).toBeNull();
    const intent = genesis.intent.value as { operation: string; forkedFrom: Record<string, unknown> };
    expect(intent.operation).toBe("fork");
    expect(intent.forkedFrom).toEqual({
      session: PARENT,
      anchor: parent.hashOf("turn-1:terminal"),
      parentSeq: 4,
      parentHead: parent.head,
      copied: 4,
    });
    expect(receipt.forkedFrom).toEqual(intent.forkedFrom);

    // Copied rows: parent genesis + input + delivery + terminal; arm and msg-2 (post-anchor) absent.
    expect(nodes.map((node) => node.id)).toEqual([
      `${CHILD}:genesis`,
      `${PARENT}:configure`,
      `fork:${PARENT}:msg-1`,
      "msg-1:delivery",
      "turn-1:terminal",
    ]);

    // The delivery marker's references were remapped with the renamed input.
    const delivery = nodes.find((node) => node.id === "msg-1:delivery");
    expect((delivery?.intent.value as { inboxId: string }).inboxId).toBe(`fork:${PARENT}:msg-1`);
    // Consumption still folds: the copied, delivered input is not pending again.
    expect(childKernel.pendingMessages(CHILD)).toEqual([]);

    // The catalog projects the ancestry edge.
    expect(stores.catalog.sessionIndex(CHILD)?.parentId).toBe(PARENT);
    expect(stores.catalog.childSessionsPage(PARENT, "", 10).map((row) => row.id)).toEqual([CHILD]);
  });

  test("inherits no alarms and admits a pre-fork idempotency key as fresh", () => {
    const parent = buildParent();
    Result.getOrThrowWith(fork(parent.hashOf("turn-1:terminal")), (error) => error);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    // No arm row was copied and the child's armed-alarm index is empty.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    expect(nodes.some((node) => node.kind === "alarm")).toBeFalse();
    expect(child().armedAlarms()).toEqual([]);
    // The parent keeps its armed alarm untouched.
    expect(stores.session.armedAlarms().map((alarm) => alarm.alarmId)).toEqual(["alarm-1"]);

    // Dedup rebuilds after genesis: the pre-fork key resolves to nothing, so a
    // replay of "msg-1" against the child appends fresh instead of deduping.
    expect(childKernel.actionById("msg-1")).toBeUndefined();
    expect(childKernel.actionById(`fork:${PARENT}:msg-1`)?.sessionId).toBe(CHILD);
    const authority = adoptWriter(childKernel, CHILD, "child-writer");
    const head = nodes[nodes.length - 1];
    Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(
          childKernel.commit({
            sessionId: CHILD,
            owner: authority.owner,
            fence: authority.fence,
            now: 101,
            expectedRevision: childKernel.row(CHILD).revision,
            actions: [
              receivedMessageAction({
                id: "msg-1",
                sessionId: CHILD,
                kind: "prompt",
                content: "replayed",
                origin: { encodingVersion: 1, value: { source: "test" } },
                parentActionId: head?.id ?? null,
                at: 101,
              }),
            ],
            state: "idle",
          }),
        ),
      ),
      (error) => error,
    );
    expect(childKernel.actionById("msg-1")?.sessionId).toBe(CHILD);
    expect(childKernel.actionById("msg-1")?.ordinal).toBe(6);
  });

  test("refuses a mid-turn anchor, an unknown anchor and an over-cap copy", () => {
    const parent = buildParent();
    const armHash = parent.hashOf("alarm-1:arm:1");
    expect(refusalOf(fork(armHash)).reason).toBe("anchor_not_boundary");
    expect(refusalOf(fork("no-such-hash")).reason).toBe("anchor_not_found");
    expect(refusalOf(fork(parent.hashOf("turn-1:terminal"), {}, { byteCap: 16 })).reason).toBe("byte_cap");
  });

  test("refuses a parent file on a different schemaVersion without writing", () => {
    const parent = buildParent();
    const refusal = refusalOf(
      fork(parent.hashOf("turn-1:terminal"), { parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION + 1 }),
    );
    expect(refusal.reason).toBe("schema_version");
    expect(child().sessions.get(CHILD)).toBeUndefined();
    expect(stores.catalog.sessionIndex(CHILD)).toBeUndefined();
  });

  test("refuses an existing child id and leaves the first chain intact", () => {
    const parent = buildParent();
    const anchor = parent.hashOf("turn-1:terminal");
    const first = Result.getOrThrowWith(fork(anchor), (error) => error);
    expect(refusalOf(fork(anchor)).reason).toBe("child_exists");
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    expect(childKernel.verifyChain(CHILD)).toEqual({ kind: "intact", head: first.head, length: 5 });
  });
});
