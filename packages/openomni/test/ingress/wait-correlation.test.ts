import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Communication, Dispatch } from "@openomni/protocol";
import { PendingAskStore, PendingInteractionStore } from "@openomni/session";
import {
  applyWaitCorrelationEffect,
  resolveWaitCorrelation,
} from "../../src/ingress/wait-correlation";

const correlation = Object.freeze({
  endpointId: "endpoint-1",
  channelId: "channel-1",
  replyToMessageId: "reply-1",
  threadId: "thread-1",
  tokenHash: "token-1",
  externalConversationId: "conversation-1",
}) satisfies Dispatch.Correlation;

function interaction(id: string): PendingInteractionStore.Record {
  return {
    id,
    workerRunId: `run-${id}`,
    sessionId: `session-${id}`,
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: {},
    allowedActions: ["report_result"],
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    followUpWindow: 0,
  };
}

function ask(id: string): Communication.PendingAsk.Record {
  return {
    id,
    originSessionId: `session-${id}`,
    originRunId: `run-${id}`,
    originActorKind: "worker",
    targetKind: "external_actor",
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: {},
    status: "open",
    createdAt: 1,
    updatedAt: 1,
  };
}

function hint(query: object): string {
  return (
    [
      "replyToMessageId",
      "threadId",
      "tokenHash",
      "externalConversationId",
      "externalMessageId",
    ].find((key) => key in query) ?? "base"
  );
}

afterEach(() => mock.restore());

describe("resolveWaitCorrelation", () => {
  test("returns none after the single scoped base interaction query when no hints are populated", () => {
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = resolveWaitCorrelation({
      correlation: { endpointId: "endpoint-1", channelId: "channel-1" },
    });

    expect(resolution).toEqual({ kind: "none", candidates: [], effect: { kind: "none" } });
    expect(pi).toHaveBeenCalledTimes(1);
    expect(pi).toHaveBeenCalledWith({ endpointId: "endpoint-1", channelId: "channel-1" });
    expect(pa).not.toHaveBeenCalled();
  });

  test("matches a PendingAsk by the private external message ID", () => {
    const record = ask("ask-external-message");
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.externalMessageId === "message-1" ? [record] : [],
    );

    const resolution = resolveWaitCorrelation({
      correlation: { endpointId: "endpoint-1", channelId: "channel-1" },
      externalMessageId: "message-1",
    });

    expect(resolution).toEqual({
      kind: "match",
      candidate: { kind: "pending_ask", key: "pending_ask:ask-external-message", record },
      effect: { kind: "none" },
    });
    expect(pa).toHaveBeenCalledWith({
      endpointId: "endpoint-1",
      channelId: "channel-1",
      externalMessageId: "message-1",
    });
  });

  test("deduplicates one interaction found through every hint before cardinality", () => {
    const record = interaction("same-interaction");
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([record]);
    spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = resolveWaitCorrelation({ correlation });

    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(resolution.candidate).toEqual({
      kind: "pending_interaction",
      key: "pending_interaction:same-interaction",
      record,
    });
  });

  test("fails closed for cross-hint PI+PI, PI+Ask, Ask+Ask, and same-ID cross-source sets", () => {
    const cases: Array<{
      pi: Record<string, PendingInteractionStore.Record[]>;
      pa: Record<string, Communication.PendingAsk.Record[]>;
      keys: string[];
    }> = [
      {
        pi: { replyToMessageId: [interaction("pi-a")], threadId: [interaction("pi-b")] },
        pa: {},
        keys: ["pending_interaction:pi-a", "pending_interaction:pi-b"],
      },
      {
        pi: { replyToMessageId: [interaction("shared")] },
        pa: { threadId: [ask("ask-b")] },
        keys: ["pending_ask:ask-b", "pending_interaction:shared"],
      },
      {
        pi: {},
        pa: { tokenHash: [ask("ask-a")], externalConversationId: [ask("ask-b")] },
        keys: ["pending_ask:ask-a", "pending_ask:ask-b"],
      },
      {
        pi: { replyToMessageId: [interaction("collision")] },
        pa: { replyToMessageId: [ask("collision")] },
        keys: ["pending_ask:collision", "pending_interaction:collision"],
      },
    ];

    for (const testCase of cases) {
      spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation(
        (query) => testCase.pi[hint(query)] ?? [],
      );
      spyOn(PendingAskStore, "findByCorrelation").mockImplementation(
        (query) => testCase.pa[hint(query)] ?? [],
      );
      const resolution = resolveWaitCorrelation({ correlation });
      expect(resolution.kind).toBe("ambiguous");
      if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
      expect(resolution.candidates.map((candidate) => candidate.key)).toEqual(testCase.keys);
      mock.restore();
    }
  });

  test("sorts source-qualified candidates independently of reverse store order", () => {
    spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [interaction("z"), interaction("a")] : [],
    );
    spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [ask("z"), ask("a")] : [],
    );

    const resolution = resolveWaitCorrelation({ correlation });

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.key)).toEqual([
      "pending_ask:a",
      "pending_ask:z",
      "pending_interaction:a",
      "pending_interaction:z",
    ]);
    expect(resolution.effect).toEqual({
      kind: "mark_pending_asks_ambiguous",
      pendingAskIds: ["a", "z"],
    });
  });

  test("executes exact ordered PI and PendingAsk queries and remains read-only", () => {
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);
    const mark = spyOn(PendingAskStore, "markAmbiguous").mockImplementation((id) => ask(id));

    resolveWaitCorrelation({ correlation, externalMessageId: "message-1" });

    expect(pi.mock.calls.map(([query]) => query)).toEqual([
      { endpointId: "endpoint-1", channelId: "channel-1", replyToMessageId: "reply-1" },
      { endpointId: "endpoint-1", channelId: "channel-1", threadId: "thread-1" },
      { endpointId: "endpoint-1", channelId: "channel-1", tokenHash: "token-1" },
      {
        endpointId: "endpoint-1",
        channelId: "channel-1",
        externalConversationId: "conversation-1",
      },
    ]);
    expect(pa.mock.calls.map(([query]) => query)).toEqual([
      { tokenHash: "token-1" },
      {
        endpointId: "endpoint-1",
        channelId: "channel-1",
        externalConversationId: "conversation-1",
      },
      { endpointId: "endpoint-1", channelId: "channel-1", replyToMessageId: "reply-1" },
      { endpointId: "endpoint-1", channelId: "channel-1", threadId: "thread-1" },
      { endpointId: "endpoint-1", channelId: "channel-1", externalMessageId: "message-1" },
    ]);
    expect(mark).not.toHaveBeenCalled();
  });

  test("constructs no effect for PI-only ambiguity and applies explicit Ask effects once per ID", () => {
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([
      interaction("pi-b"),
      interaction("pi-a"),
    ]);
    spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);
    const resolution = resolveWaitCorrelation({ correlation });
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.effect).toEqual({ kind: "none" });

    const mark = spyOn(PendingAskStore, "markAmbiguous").mockImplementation((id) => ask(id));
    applyWaitCorrelationEffect({
      kind: "mark_pending_asks_ambiguous",
      pendingAskIds: ["ask-b", "ask-a", "ask-b"],
    });
    expect(mark).toHaveBeenCalledTimes(2);
    expect(mark.mock.calls.map(([id]) => id)).toEqual(["ask-b", "ask-a"]);
  });
});
