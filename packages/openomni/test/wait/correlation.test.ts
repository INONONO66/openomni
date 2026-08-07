import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PendingAskStore, PendingInteractionStore, WaitStore } from "@openomni/session";
import { findWaitCandidates } from "../../src/wait/index";
import {
  buildAsk,
  buildInteraction,
  buildWaitRecord,
  correlationFixture as correlation,
} from "../helpers/wait";

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

describe("findWaitCandidates", () => {
  test("returns none after querying all three backings at the scoped fallback level", () => {
    const wait = spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({
      correlation: { endpointId: "endpoint-1", channelId: "channel-1" },
    });

    expect(resolution).toEqual({ kind: "none" });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith({ endpointId: "endpoint-1", channelId: "channel-1" });
    expect(pi).toHaveBeenCalledTimes(1);
    expect(pi).toHaveBeenCalledWith({ endpointId: "endpoint-1", channelId: "channel-1" });
    expect(pa).toHaveBeenCalledTimes(1);
    expect(pa).toHaveBeenCalledWith({ endpointId: "endpoint-1", channelId: "channel-1" });
  });

  test("resolves the wait table first and never consults frozen legacy rows on a hit", () => {
    const record = buildWaitRecord("wait-first");
    const wait = spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash === correlation.tokenHash ? [record] : [],
    );
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([
      buildInteraction("legacy-shadowed"),
    ]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({ correlation });

    expect(resolution).toEqual({
      kind: "match",
      candidate: { source: "wait", key: "wait:wait-first", wait: record },
    });
    expect(wait.mock.calls.map(([query]) => hint(query))).toEqual([
      "replyToMessageId",
      "threadId",
      "tokenHash",
    ]);
    expect(pi).not.toHaveBeenCalled();
    expect(pa).not.toHaveBeenCalled();
  });

  test("keeps same-level wait-table ambiguity a typed rejection", () => {
    spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash === correlation.tokenHash
        ? [buildWaitRecord("wait-b"), buildWaitRecord("wait-a")]
        : [],
    );
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({ correlation });

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.key)).toEqual([
      "wait:wait-a",
      "wait:wait-b",
    ]);
    expect(pi).not.toHaveBeenCalled();
  });

  test("drops wait rows whose endpoint or channel pin contradicts the inbound claim", () => {
    const pinnedElsewhere = buildWaitRecord("wait-other-surface", {
      correlation: {
        endpointId: "endpoint-2",
        channelId: "channel-2",
        tokenHash: correlation.tokenHash,
      },
    });
    const unpinned = buildWaitRecord("wait-unpinned", {
      correlation: { tokenHash: correlation.tokenHash },
    });
    spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash === correlation.tokenHash ? [pinnedElsewhere, unpinned] : [],
    );
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({ correlation });

    expect(resolution).toEqual({
      kind: "match",
      candidate: { source: "wait", key: "wait:wait-unpinned", wait: unpinned },
    });
  });

  test("keeps a multi-responder wait claimable from a responder's own endpoint, channel scope enforced", () => {
    // The endpoint pin on a multi-responder wait is the DELIVERY endpoint;
    // expected responders reply from their OWN endpoints in the same channel,
    // so the pin must not exclude the row at lookup. Identity stays gated by
    // the matcher + fold. Channel scope still excludes.
    const multiResponder = buildWaitRecord("wait-multi", {
      correlation: {
        endpointId: "endpoint-delivery-target",
        channelId: correlation.channelId,
        tokenHash: correlation.tokenHash,
      },
      expectedResponders: ["actor-r1", "actor-r2", "actor-r3"],
      resolutionPolicy: "quorum",
      quorum: { expected: 3, threshold: 2 },
    });
    const otherChannel = buildWaitRecord("wait-multi-other-channel", {
      correlation: {
        endpointId: "endpoint-delivery-target",
        channelId: "channel-elsewhere",
        tokenHash: correlation.tokenHash,
      },
      expectedResponders: ["actor-r1", "actor-r2"],
    });
    spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash === correlation.tokenHash ? [multiResponder, otherChannel] : [],
    );
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({ correlation });

    expect(resolution).toEqual({
      kind: "match",
      candidate: { source: "wait", key: "wait:wait-multi", wait: multiResponder },
    });
  });

  test("matches a PendingAsk by the private external message ID", () => {
    const record = buildAsk("ask-external-message");
    spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.externalMessageId === "message-1" ? [record] : [],
    );

    const resolution = findWaitCandidates({
      correlation: { endpointId: "endpoint-1", channelId: "channel-1" },
      externalMessageId: "message-1",
    });

    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(resolution.candidate).toMatchObject({
      source: "pending_ask",
      key: "pending_ask:ask-external-message",
      record,
    });
    expect(pa).toHaveBeenCalledWith({
      endpointId: "endpoint-1",
      channelId: "channel-1",
      externalMessageId: "message-1",
    });
  });

  test("preserves a PendingAsk external message ID lookup without optional correlation", () => {
    const record = buildAsk("ask-external-message-without-correlation");
    const wait = spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.externalMessageId === "message-without-correlation" ? [record] : [],
    );

    const resolution = findWaitCandidates({
      externalMessageId: "message-without-correlation",
    });

    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(resolution.candidate).toMatchObject({
      source: "pending_ask",
      key: "pending_ask:ask-external-message-without-correlation",
      record,
    });
    expect(wait).not.toHaveBeenCalled();
    expect(pi).not.toHaveBeenCalled();
    expect(pa).toHaveBeenCalledTimes(1);
    expect(pa).toHaveBeenCalledWith({ externalMessageId: "message-without-correlation" });
  });

  test("scopes PendingAsk token lookup to its endpoint and channel", () => {
    const local = buildAsk("ask-local-token");
    const otherSurface = buildAsk("ask-other-surface-token", {
      endpointId: "endpoint-2",
      channelId: "channel-2",
    });
    spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) => {
      if (query.tokenHash !== "shared-token") return [];
      return query.endpointId === correlation.endpointId &&
        query.channelId === correlation.channelId
        ? [local]
        : [local, otherSurface];
    });

    const resolution = findWaitCandidates({
      correlation: {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        tokenHash: "shared-token",
      },
    });

    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(resolution.candidate).toMatchObject({
      source: "pending_ask",
      key: "pending_ask:ask-local-token",
      record: local,
    });
    expect(pa).toHaveBeenCalledTimes(1);
    expect(pa).toHaveBeenCalledWith({
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      tokenHash: "shared-token",
    });
  });

  test("deduplicates duplicate records within the winning precedence level", () => {
    const record = buildInteraction("same-interaction");
    spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([record, record]);
    spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({ correlation });

    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(resolution.candidate).toMatchObject({
      source: "pending_interaction",
      key: "pending_interaction:same-interaction",
      record,
    });
  });

  test("routes an exact higher-priority reply despite broader lower-priority matches", () => {
    const exact = buildInteraction("pi-exact");
    spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation((query) => {
      if (query.replyToMessageId) return [exact];
      if (query.threadId) return [buildInteraction("pi-thread-broad")];
      return [];
    });
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash ? [buildAsk("ask-token-broad")] : [],
    );

    const resolution = findWaitCandidates({ correlation });

    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(resolution.candidate).toMatchObject({
      source: "pending_interaction",
      key: "pending_interaction:pi-exact",
      record: exact,
    });
    expect(pi.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
    expect(pa.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
  });

  test("fails closed for multiple source-qualified candidates at the winning level", () => {
    spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [buildInteraction("collision")] : [buildInteraction("lower")],
    );
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [buildAsk("collision")] : [buildAsk("lower")],
    );

    const resolution = findWaitCandidates({ correlation });

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.key)).toEqual([
      "pending_ask:collision",
      "pending_interaction:collision",
    ]);
    expect(pi.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
    expect(pa.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
  });

  test("sorts source-qualified candidates independently of reverse store order", () => {
    spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [buildInteraction("z"), buildInteraction("a")] : [],
    );
    spyOn(PendingAskStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [buildAsk("z"), buildAsk("a")] : [],
    );

    const resolution = findWaitCandidates({ correlation });

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.key)).toEqual([
      "pending_ask:a",
      "pending_ask:z",
      "pending_interaction:a",
      "pending_interaction:z",
    ]);
  });

  test("executes exact ordered queries across all backings and stays read-only", () => {
    const wait = spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    const pi = spyOn(PendingInteractionStore, "findByCorrelation").mockReturnValue([]);
    const pa = spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);
    const markAmbiguous = spyOn(PendingAskStore, "markAmbiguous").mockImplementation((id) =>
      buildAsk(id),
    );
    const resolve = spyOn(PendingInteractionStore, "resolve").mockImplementation((id) =>
      buildInteraction(id),
    );

    findWaitCandidates({ correlation, externalMessageId: "message-1" });

    expect(wait.mock.calls.map(([query]) => query)).toEqual([
      { replyToMessageId: "reply-1" },
      { threadId: "thread-1" },
      { tokenHash: "token-1" },
      { externalConversationId: "conversation-1" },
    ]);
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
    // Frozen legacy rows: the lookup never mutates candidates, even on ambiguity.
    expect(markAmbiguous).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  test("upcasts a legacy match into a Wait view without writing legacy stores", () => {
    const record = buildInteraction("pi-view", { targetActorId: "actor-pinned" });
    spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);
    spyOn(PendingInteractionStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [record] : [],
    );
    spyOn(PendingAskStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({ correlation });

    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(resolution.candidate.wait).toMatchObject({
      id: "pi-view",
      ownerRef: { kind: "session", id: "session-pi-view" },
      correlation: { endpointId: "endpoint-1", channelId: "channel-1" },
      expectedResponders: ["actor-pinned"],
      resolutionPolicy: "first_reply",
      status: "open",
    });
  });
});
