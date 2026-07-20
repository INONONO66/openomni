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
  test("returns none after querying both migration backings at the scoped fallback level", () => {
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = resolveWaitCorrelation({
      correlation: { endpointId: "endpoint-1", channelId: "channel-1" },
    });

    expect(resolution).toEqual({ kind: "none", candidates: [], effect: { kind: "none" } });
    expect(pi).toHaveBeenCalledTimes(1);
    expect(pi).toHaveBeenCalledWith({ endpointId: "endpoint-1", channelId: "channel-1" });
    expect(pa).toHaveBeenCalledTimes(1);
    expect(pa).toHaveBeenCalledWith({ endpointId: "endpoint-1", channelId: "channel-1" });
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

  test("preserves a PendingAsk external message ID lookup without optional correlation", () => {
    const record = ask("ask-external-message-without-correlation");
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.externalMessageId === "message-without-correlation" ? [record] : [],
    );

    const resolution = resolveWaitCorrelation({
      externalMessageId: "message-without-correlation",
    });

    expect(resolution).toEqual({
      kind: "match",
      candidate: {
        kind: "pending_ask",
        key: "pending_ask:ask-external-message-without-correlation",
        record,
      },
      effect: { kind: "none" },
    });
    expect(pi).not.toHaveBeenCalled();
    expect(pa).toHaveBeenCalledTimes(1);
    expect(pa).toHaveBeenCalledWith({ externalMessageId: "message-without-correlation" });
  });

  test("scopes PendingAsk token lookup to its endpoint and channel", () => {
    const local = ask("ask-local-token");
    const otherSurface = {
      ...ask("ask-other-surface-token"),
      endpointId: "endpoint-2",
      channelId: "channel-2",
    };
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) => {
      if (query.tokenHash !== "shared-token") return [];
      return query.endpointId === correlation.endpointId &&
        query.channelId === correlation.channelId
        ? [local]
        : [local, otherSurface];
    });

    const resolution = resolveWaitCorrelation({
      correlation: {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        tokenHash: "shared-token",
      },
    });

    expect(resolution).toEqual({
      kind: "match",
      candidate: { kind: "pending_ask", key: "pending_ask:ask-local-token", record: local },
      effect: { kind: "none" },
    });
    expect(pa).toHaveBeenCalledTimes(1);
    expect(pa).toHaveBeenCalledWith({
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      tokenHash: "shared-token",
    });
  });

  test("deduplicates duplicate records within the winning precedence level", () => {
    const record = interaction("same-interaction");
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([record, record]);
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

  test("routes an exact higher-priority reply despite broader lower-priority matches", () => {
    const exact = interaction("pi-exact");
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation((query) => {
      if (query.replyToMessageId) return [exact];
      if (query.threadId) return [interaction("pi-thread-broad")];
      return [];
    });
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash ? [ask("ask-token-broad")] : [],
    );

    const resolution = resolveWaitCorrelation({ correlation });

    expect(resolution).toEqual({
      kind: "match",
      candidate: {
        kind: "pending_interaction",
        key: "pending_interaction:pi-exact",
        record: exact,
      },
      effect: { kind: "none" },
    });
    expect(pi.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
    expect(pa.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
  });

  test("fails closed for multiple source-qualified candidates at the winning level", () => {
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [interaction("collision")] : [interaction("lower-priority")],
    );
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [ask("collision")] : [ask("lower-priority")],
    );

    const resolution = resolveWaitCorrelation({ correlation });

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.key)).toEqual([
      "pending_ask:collision",
      "pending_interaction:collision",
    ]);
    expect(resolution.effect).toEqual({
      kind: "mark_pending_asks_ambiguous",
      pendingAskIds: ["collision"],
    });
    expect(pi.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
    expect(pa.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
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
      { endpointId: "endpoint-1", channelId: "channel-1", replyToMessageId: "reply-1" },
      { endpointId: "endpoint-1", channelId: "channel-1", threadId: "thread-1" },
      { endpointId: "endpoint-1", channelId: "channel-1", tokenHash: "token-1" },
      {
        endpointId: "endpoint-1",
        channelId: "channel-1",
        externalConversationId: "conversation-1",
      },
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
