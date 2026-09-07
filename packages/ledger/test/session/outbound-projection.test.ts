import { afterEach, beforeEach, expect, test } from "bun:test";
import { canonicalDigest, type LedgerAction, type SessionTransition } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  SessionHandleStore.materialize({ id: "source", parentId: null, role: "resident", tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: 0, actionId: "configure", at: 1 });
});
afterEach(() => Storage.reset());

function append(action: LedgerAction.Append) {
  const receipt = Storage.get().actions?.append(action, SessionHandleStore.row("source").revision);
  if (receipt === undefined) throw new Error("projection fixture commit failed");
}

test("outbound projection folds a verified acknowledgement without erasing its pending history", () => {
  const payload = { messageId: "terminal:reply", sourceSessionId: "source", sourceActionId: "terminal",
    destinationSessionId: "receiver", requestId: "original", replyTo: "binding", terminal: "completed" as const, content: "answer" };
  const message: SessionTransition.OutboundMessage = { ...payload, digest: canonicalDigest(payload) };
  append({ id: "pending", parentId: "configure", sessionId: "source", kind: "outbound", ts: 2, irreversible: true,
    intent: { encodingVersion: 1, value: { op: "open" } },
    effect: { encodingVersion: 1, value: { outbound: { message, state: "pending", destinationReceipt: null } } },
  });
  expect(SessionHandleStore.outboundRows("source")).toEqual([{ message, state: "pending", destinationReceipt: null }]);
  append({ id: "ack", parentId: "pending", sessionId: "source", kind: "outbound", ts: 3, irreversible: true,
    intent: { encodingVersion: 1, value: { op: "ack" } },
    effect: { encodingVersion: 1, value: { outbound: { message, state: "delivered", destinationReceipt: { id: "received", revision: 2 } } } },
  });
  expect(SessionHandleStore.outboundRows("source")).toEqual([{ message, state: "delivered", destinationReceipt: { id: "received", revision: 2 } }]);
  expect(SessionHandleStore.tree("source").map((action) => action.id)).toEqual(["configure", "pending", "ack"]);
});

test("corrupt outbound evidence cannot silently disappear from recovery", () => {
  append({ id: "corrupt", parentId: "configure", sessionId: "source", kind: "outbound", ts: 2, irreversible: true,
    intent: { encodingVersion: 1, value: { op: "open" } }, effect: { encodingVersion: 1, value: null } });
  expect(() => SessionHandleStore.outboundRows("source")).toThrow("invalid outbound action effect");
});
