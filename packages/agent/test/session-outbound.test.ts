import { afterEach, beforeEach, expect, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { receiveOutbound } from "./helpers/receive-outbound";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  session,
  closeSessions,
  sweepSessions,
  wakeSession,
  type SessionRuntime,
} from "../src/session-handle";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The parent's pending "commission" message action that a child's outbound reply answers. */
function appendCommission(): void {
  const actions = Storage.get().actions;
  if (actions === undefined) throw new Error("missing action adapter");
  actions.append(
    {
      id: "commission-action",
      parentId: null,
      sessionId: "parent",
      kind: "message",
      intent: {
        encodingVersion: 1,
        value: { phase: "intent", value: { messageId: "commission" } },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      ts: 100,
      irreversible: true,
    },
    SessionHandleStore.row("parent").revision,
  );
}

const runtimes: SessionRuntime[] = [];
const directories: string[] = [];
beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  seedPolicy();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => closeSessions(runtime)));
  Storage.reset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("a dropped receiving consumer leaves a sealed source obligation without mutating its parent", async () => {
  const runtime: SessionRuntime = {
    observations: { publish: () => undefined },
    clock: () => 100,
    async dispatchOutbound() {
      throw new Error("receiver unavailable");
    },
  };
  runtimes.push(runtime);
  session(
    { id: "parent", role: "resident", runner: async () => ({ kind: "result", text: "parent" }) },
    runtime,
  );
  const child = session(
    {
      id: "child",
      parentId: "parent",
      role: "worker",
      runner: async () => ({ kind: "result", text: "child answer" }),
    },
    runtime,
  );
  const before = SessionHandleStore.tree("parent");
  await expect(
    child.prompt("work", {
      encodingVersion: 1,
      value: {
        kind: "message",
        messageId: "commission",
        senderSessionId: "parent",
        sourceActionId: "commission-action",
      },
    }),
  ).rejects.toThrow("receiver unavailable");
  expect(SessionHandleStore.tree("parent")).toEqual(before);
  expect(SessionHandleStore.inboxRows("parent")).toEqual([]);
  const source = SessionHandleStore.tree("child");
  expect(
    source.filter((action) => SessionHandleStore.turnTerminal(action) !== undefined),
  ).toHaveLength(1);
  const obligations = SessionHandleStore.outboundRows("child");
  expect(obligations).toHaveLength(1);
  expect(obligations[0]?.state).toBe("pending");
  expect(obligations[0]?.message.content).toBe("child answer");
});

test("restart after receiving commit retries exact bytes without another inbox or receiver execution", async () => {
  Storage.reset();
  const directory = mkdtempSync(join(tmpdir(), "source-obligation-"));
  directories.push(directory);
  const dbPath = join(directory, "ledger.sqlite");
  Storage.initialize({ dbPath });
  seedPolicy();
  let consumed = 0;
  const parentRunner = async () => {
    consumed += 1;
    return { kind: "result" as const, text: "received" };
  };
  const sent: string[] = [];
  function runtime(at: number, loseAck: boolean): SessionRuntime {
    const value: SessionRuntime = {
      observations: { publish: () => undefined },
      clock: () => at,
      async dispatchOutbound({ message }) {
        sent.push(JSON.stringify(message));
        const received = receiveOutbound(message, at);
        await wakeSession(message.destinationSessionId, parentRunner, value);
        if (loseAck) throw new Error("source ack lost");
        return received.receipt;
      },
    };
    runtimes.push(value);
    return value;
  }
  const first = runtime(100, true);
  session({ id: "parent", role: "resident", runner: parentRunner }, first);
  appendCommission();
  const child = session(
    {
      id: "child",
      parentId: "parent",
      role: "worker",
      runner: async () => ({ kind: "result", text: "exact answer" }),
    },
    first,
  );
  await expect(
    child.prompt("work", {
      encodingVersion: 1,
      value: {
        kind: "message",
        messageId: "commission",
        senderSessionId: "parent",
        sourceActionId: "commission-action",
      },
    }),
  ).rejects.toThrow("source ack lost");
  expect(consumed).toBe(1);
  const parentBefore = SessionHandleStore.tree("parent");
  expect(SessionHandleStore.outboundRows("child")[0]?.state).toBe("pending");
  await closeSessions(first);
  Storage.reset();
  Storage.initialize({ dbPath });
  const reopened = runtime(200, false);
  await sweepSessions(
    (row) =>
      row.id === "parent"
        ? parentRunner
        : async () => {
            throw new Error("sealed child replayed");
          },
    reopened,
  );
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  expect(consumed).toBe(1);
  expect(SessionHandleStore.tree("parent")).toEqual(parentBefore);
  expect(SessionHandleStore.inboxRows("parent")).toHaveLength(1);
  expect(SessionHandleStore.outboundRows("child")[0]?.state).toBe("delivered");
});

function commissionedChild(runtime: SessionRuntime) {
  runtimes.push(runtime);
  session(
    { id: "parent", role: "resident", runner: async () => ({ kind: "result", text: "parent" }) },
    runtime,
  );
  appendCommission();
  const child = session(
    {
      id: "child",
      parentId: "parent",
      role: "worker",
      runner: async () => ({ kind: "result", text: "child answer" }),
    },
    runtime,
  );
  return child.prompt("work", {
    encodingVersion: 1,
    value: {
      kind: "message",
      messageId: "commission",
      senderSessionId: "parent",
      sourceActionId: "commission-action",
    },
  });
}

test("a destination receipt for different bytes is refused and the obligation stays pending", async () => {
  const prompted = commissionedChild({
    observations: { publish: () => undefined },
    clock: () => 100,
    dispatchOutbound: async ({ message }) =>
      receiveOutbound({ ...message, content: "tampered answer" }, 100).receipt,
  });
  await expect(prompted).rejects.toThrow(
    "outbound destination receipt does not match its recorded payload",
  );
  expect(SessionHandleStore.outboundRows("child")).toMatchObject([{ state: "pending" }]);
  expect(SessionHandleStore.inboxRows("parent").map((row) => row.content)).toEqual([
    "tampered answer",
  ]);
});

test("a lease stolen during dispatch fails both the ack and the release as one aggregate", async () => {
  const prompted = commissionedChild({
    observations: { publish: () => undefined },
    clock: () => 100,
    dispatchOutbound: async ({ message }) => {
      const stolen = SessionHandleStore.acquireLease({
        sessionId: message.sourceSessionId,
        owner: "other-runtime",
        expectedFence: SessionHandleStore.row(message.sourceSessionId).leaseFence,
        now: 100 + SessionHandleStore.LEASE_TTL_MS,
        expiresAt: 100 + 2 * SessionHandleStore.LEASE_TTL_MS,
      });
      if (!stolen.ok) throw new Error("test takeover refused");
      return receiveOutbound(message, 100).receipt;
    },
  });
  const failure = await prompted.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("unreachable");
  expect(failure.message).toBe("outbound dispatch and source lease release failed");
  expect(failure.errors.map((error) => String(error))).toEqual([
    "SessionCommitError: session commit stale",
    "SessionCommitError: session commit stale",
  ]);
  expect(SessionHandleStore.outboundRows("child")).toMatchObject([{ state: "pending" }]);
  expect(SessionHandleStore.row("child").leaseOwner).toBe("other-runtime");
});
