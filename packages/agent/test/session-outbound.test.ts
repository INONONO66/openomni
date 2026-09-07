import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { SEEDED_POLICY_ROWS } from "@openomni/policy";

const runtimes: SessionRuntime[] = [];
const directories: string[] = [];
beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("missing policy adapter");
  for (const row of SEEDED_POLICY_ROWS) policies.append({ ...row, generation: 1 });
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
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("missing policy adapter");
  for (const row of SEEDED_POLICY_ROWS) policies.append({ ...row, generation: 1 });
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
        const received = SessionHandleStore.commitReceivedMessage({
          id: message.messageId,
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: message.content,
          origin: { encodingVersion: 1, value: message },
          createdAt: at,
          parentActionId: null,
        });
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
