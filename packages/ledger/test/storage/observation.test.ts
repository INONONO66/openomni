import type { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  Gateway,
  type Inbox,
  L0Observation,
  LedgerAction,
  type ObservationSink,
  SessionTransition,
} from "@openomni/protocol";
import { publishCommitted } from "../../src/storage/sqlite-l0-observation";
import { openLedgerDatabase } from "../helpers/ledger";

function action(
  kind: LedgerAction.Kind,
  id: string,
  intent: LedgerAction.Node["intent"]["value"],
  effect: LedgerAction.Node["effect"]["value"] = {},
): LedgerAction.Receipt {
  return {
    revision: 1,
    action: LedgerAction.Node.parse({
      id,
      sessionId: "session",
      parentId: null,
      kind,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
      irreversible: true,
      ts: 20,
      ordinal: 1,
      prevHash: "previous",
      actionHash: "current",
    }),
  };
}

function capture() {
  const events: Array<{ name: string; payload: string; sessionId?: string }> = [];
  const sink: ObservationSink = {
    publish(event, payload) {
      events.push({ name: event.name, payload: JSON.stringify(payload) });
    },
    scope(identity) {
      return {
        publish(event, payload) {
          events.push({ name: event.name, payload: JSON.stringify(payload), sessionId: identity.sessionId });
        },
      };
    },
  };
  return { events, sink };
}

function requestRow(db: Database, intent: object = { value: { messageId: "platform-1" } }): void {
  db.run("INSERT INTO session (id, role, state) VALUES ('session', 'resident', 'idle')");
  db.query(
    `INSERT INTO action (
      id, session_id, kind, intent, effect, irreversible, encoding_version,
      ts, ordinal, prev_hash, action_hash
    ) VALUES ('original', 'session', 'tool', ?, '{}', 1, 1, 8, 1, 'previous', 'current')`,
  ).run(JSON.stringify(intent));
}

test("a committed reply prompt publishes its scoped platform message identity", () => {
  using db = openLedgerDatabase();
  requestRow(db);
  const { events, sink } = capture();
  const origin: Inbox.ReplyOrigin = {
    kind: "external_reply",
    messageId: "reply-1",
    sourceActionId: "original",
    replyTo: "platform-0",
  };

  publishCommitted(db, sink, action("prompt", "reply-action", origin));

  expect(events).toEqual([
    {
      name: L0Observation.ActionCommittedEvent.name,
      payload: JSON.stringify({ id: "reply-action", sessionId: "session", revision: 1, kind: "prompt" }),
    },
    {
      name: Gateway.MessageObserved.name,
      payload: JSON.stringify({
        kind: "message.replied",
        messageId: "platform-1",
        replyTo: "platform-0",
        roundTripMs: 12,
      }),
      sessionId: "session",
    },
  ]);
});

test("a native outbound message uses its request binding for the reply observation", () => {
  using db = openLedgerDatabase();
  requestRow(db);
  const { events, sink } = capture();
  const outbound: SessionTransition.OutboundMessage = {
    messageId: "outbound",
    sourceSessionId: "worker",
    sourceActionId: "terminal",
    destinationSessionId: "session",
    requestId: "original",
    replyTo: "platform-0",
    terminal: "completed",
    content: "done",
    digest: "digest",
  };

  publishCommitted(db, sink, action("prompt", "native-reply", outbound));

  expect(events[1]).toEqual({
    name: Gateway.MessageObserved.name,
    payload: JSON.stringify({
      kind: "message.replied",
      messageId: "platform-1",
      replyTo: "platform-0",
      roundTripMs: 12,
    }),
    sessionId: "session",
  });
});

test("a reply deadline publishes a timeout from its original source identity", () => {
  using db = openLedgerDatabase();
  requestRow(db, { value: null });
  const { events, sink } = capture();
  const request = SessionTransition.Request.parse({
    requestId: "original",
    sessionId: "session",
    turnId: null,
    callId: "call",
    mode: "reply",
    parsedInput: {},
    inputHash: "input",
    effectHash: "effect",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions: {},
    deadline: 20,
    expectedResponders: ["actor"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "expired",
    outcome: "outcome_unknown",
    createdAt: 3,
  });

  publishCommitted(db, sink, action("request", "original:resolution", {}, { request }));

  expect(events[1]).toEqual({
    name: Gateway.MessageObserved.name,
    payload: JSON.stringify({ kind: "message.timed_out", messageId: "original", waitedMs: 17 }),
    sessionId: "session",
  });
});

test("observation delivery failure does not revoke an already committed action", () => {
  using db = openLedgerDatabase();
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const sink: ObservationSink = {
    publish() {
      throw new Error("subscriber unavailable");
    },
  };
  try {
    expect(() => publishCommitted(db, sink, action("turn", "committed", {}))).not.toThrow();
    expect(warning).toHaveBeenCalledWith("post-commit observation failed: committed");
  } finally {
    warning.mockRestore();
  }
});
