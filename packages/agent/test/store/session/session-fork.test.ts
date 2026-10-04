import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LedgerAction } from "@openomni/protocol";
import { useMemoryStores, testNow } from "../helpers/storage";
import { CHILD, PARENT, forkFixture } from "../helpers/fork-fixture";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { openSessionStore, SESSION_FILE_SCHEMA_VERSION, type SessionStore } from "../../../src/core/store/session-file";
import { receivedMessageAction } from "../../../src/core/commit";
import { isForkBoundary } from "../../../src/core/fork";

const stores = useMemoryStores();
let childStore: SessionStore | undefined;

beforeEach(() => {
  childStore = openSessionStore(":memory:", { now: testNow });
});

afterEach(() => {
  childStore?.close();
  childStore = undefined;
});

function child(): SessionStore {
  if (childStore === undefined) throw new Error("child store only exists inside a test");
  return childStore;
}

const fixture = forkFixture(stores, child);

describe("Session.fork", () => {
  test("forks at a turn terminal into an independently verifiable child chain", () => {
    const parent = fixture.buildParent();
    const receipt = fixture.forked(parent.hashOf("turn-1:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    // The child chain verifies on its own hashes, with its own head.
    const verdict = childKernel.verifyChain(CHILD);
    if (verdict.kind !== "intact") throw new Error("child chain not intact");
    expect(verdict.head).toBe(receipt.head);
    expect(verdict.head).not.toBe(parent.head);

    // Genesis pins the parent, the anchor, its ordinal and the parent head.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    const genesis = nodes[0];
    if (genesis === undefined) throw new Error("child genesis missing");
    expect(genesis.kind).toBe("session.configure");
    expect(genesis.parentId).toBeNull();
    const intent = genesis.intent.value as { operation: string; forkedFrom: unknown };
    expect(intent.operation).toBe("fork");
    expect(intent.forkedFrom as Record<string, unknown>).toEqual({
      session: PARENT,
      anchor: parent.hashOf("turn-1:terminal"),
      parentSeq: 4,
      parentHead: parent.head,
      copied: 4,
    });
    expect(receipt.forkedFrom).toEqual(intent.forkedFrom as typeof receipt.forkedFrom);

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

    // A later parent append is independent: the pinned child chain still verifies.
    fixture.commit(parent.authority, [
      receivedMessageAction({
        id: "msg-3",
        sessionId: PARENT,
        kind: "prompt",
        content: "post-fork",
        origin: { encodingVersion: 1, value: { source: "test" } },
        parentActionId: "msg-2",
        at: 6,
      }),
    ]);
    expect(childKernel.verifyChain(CHILD)).toEqual({ kind: "intact", head: receipt.head, length: 5 });
    expect(receipt.forkedFrom.parentHead).toBe(parent.head);
  });

  test("accepts prompt anchors; compaction hashes are boundaries by rule", () => {
    const parent = fixture.buildParent();
    // A prompt row (here the pending msg-2) is a legal boundary anchor.
    const receipt = fixture.forked(parent.hashOf("msg-2"));
    expect(receipt.forkedFrom.anchor).toBe(parent.hashOf("msg-2"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const verdict = childKernel.verifyChain(CHILD);
    expect(verdict.kind).toBe("intact");
    // The arm between terminal and msg-2 is still excluded from the copy.
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    expect(nodes.some((node) => node.kind === "alarm")).toBeFalse();
    // The boundary rule itself admits compaction rows (their writer is plugin-level).
    const compaction: LedgerAction.Node = {
      id: "cut", parentId: null, sessionId: PARENT, kind: "compaction",
      intent: { encodingVersion: 1, value: {} }, effect: { encodingVersion: 1, value: {} },
      irreversible: true, ts: 1, ordinal: 1, prevHash: "p", actionHash: "h",
    };
    expect(isForkBoundary(compaction)).toBeTrue();
    expect(isForkBoundary({ ...compaction, kind: "alarm" })).toBeFalse();
  });

  test("refuses a mid-turn anchor, an unknown anchor and an over-cap copy", () => {
    const parent = fixture.buildParent();
    const armHash = parent.hashOf("alarm-1:arm:1");
    expect(fixture.refusalOf(fixture.fork(armHash)).reason).toBe("anchor_not_boundary");
    expect(fixture.refusalOf(fixture.fork("no-such-hash")).reason).toBe("anchor_not_found");
    expect(
      fixture.refusalOf(fixture.fork(parent.hashOf("turn-1:terminal"), {}, { byteCap: 16 })).reason,
    ).toBe("byte_cap");
  });

  test("refuses a parent file on a different schemaVersion without writing", () => {
    const parent = fixture.buildParent();
    const refusal = fixture.refusalOf(
      fixture.fork(parent.hashOf("turn-1:terminal"), {
        parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION + 1,
      }),
    );
    expect(refusal.reason).toBe("schema_version");
    expect(child().sessions.get(CHILD)).toBeUndefined();
    expect(stores.catalog.sessionIndex(CHILD)).toBeUndefined();
  });

  test("refuses an existing child id and leaves the first chain intact", () => {
    const parent = fixture.buildParent();
    const anchor = parent.hashOf("turn-1:terminal");
    const first = fixture.forked(anchor);
    expect(fixture.refusalOf(fixture.fork(anchor)).reason).toBe("child_exists");
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    expect(childKernel.verifyChain(CHILD)).toEqual({ kind: "intact", head: first.head, length: 5 });
  });
});
