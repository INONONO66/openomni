import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { WaitStore } from "@openomni/ledger";
import { findWaitCandidates } from "../../../src/router/wait/index";
import { buildWaitRecord, correlationFixture as correlation } from "../../helpers/wait";

function hint(query: object): string {
  return (
    ["replyToMessageId", "threadId", "tokenHash", "externalConversationId"].find(
      (key) => key in query,
    ) ?? "base"
  );
}

afterEach(() => mock.restore());

describe("findWaitCandidates", () => {
  test("returns none after querying down to the scoped fallback level", () => {
    const wait = spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);

    const resolution = findWaitCandidates({ endpointId: "endpoint-1", channelId: "channel-1" });

    expect(resolution).toEqual({ kind: "none" });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith({ endpointId: "endpoint-1", channelId: "channel-1" });
  });

  test("returns none without querying when correlation is absent", () => {
    const wait = spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);

    expect(findWaitCandidates(undefined)).toEqual({ kind: "none" });
    expect(wait).not.toHaveBeenCalled();
  });

  test("resolves at the most specific level and stops querying lower levels", () => {
    const record = buildWaitRecord("wait-first");
    const wait = spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash === correlation.tokenHash ? [record] : [],
    );

    const resolution = findWaitCandidates(correlation);

    expect(resolution).toEqual({
      kind: "match",
      candidate: { key: "wait:wait-first", wait: record },
    });
    expect(wait.mock.calls.map(([query]) => hint(query))).toEqual([
      "replyToMessageId",
      "threadId",
      "tokenHash",
    ]);
  });

  test("keeps same-level ambiguity a typed rejection", () => {
    spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.tokenHash === correlation.tokenHash
        ? [buildWaitRecord("wait-b"), buildWaitRecord("wait-a")]
        : [],
    );

    const resolution = findWaitCandidates(correlation);

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.key)).toEqual([
      "wait:wait-a",
      "wait:wait-b",
    ]);
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

    const resolution = findWaitCandidates(correlation);

    expect(resolution).toEqual({
      kind: "match",
      candidate: { key: "wait:wait-unpinned", wait: unpinned },
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

    const resolution = findWaitCandidates(correlation);

    expect(resolution).toEqual({
      kind: "match",
      candidate: { key: "wait:wait-multi", wait: multiResponder },
    });
  });

  test("deduplicates duplicate records within the winning precedence level", () => {
    const record = buildWaitRecord("same-wait");
    spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [record, record] : [],
    );

    const resolution = findWaitCandidates(correlation);

    expect(resolution).toEqual({
      kind: "match",
      candidate: { key: "wait:same-wait", wait: record },
    });
  });

  test("routes an exact higher-priority reply despite broader lower-priority matches", () => {
    const exact = buildWaitRecord("wait-exact");
    const wait = spyOn(WaitStore, "findByCorrelation").mockImplementation((query) => {
      if (query.replyToMessageId) return [exact];
      if (query.threadId) return [buildWaitRecord("wait-thread-broad")];
      return [];
    });

    const resolution = findWaitCandidates(correlation);

    expect(resolution).toEqual({
      kind: "match",
      candidate: { key: "wait:wait-exact", wait: exact },
    });
    expect(wait.mock.calls.map(([query]) => hint(query))).toEqual(["replyToMessageId"]);
  });

  test("sorts ambiguous candidates independently of store order and stays read-only", () => {
    spyOn(WaitStore, "findByCorrelation").mockImplementation((query) =>
      query.replyToMessageId ? [buildWaitRecord("z"), buildWaitRecord("a")] : [],
    );

    const resolution = findWaitCandidates(correlation);

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.key)).toEqual([
      "wait:a",
      "wait:z",
    ]);
  });

  test("executes exact ordered queries over the wait table", () => {
    const wait = spyOn(WaitStore, "findByCorrelation").mockReturnValue([]);

    findWaitCandidates(correlation);

    // externalConversationId supersedes the scoped endpoint+channel fallback
    // (waitTierLevels emits one or the other, never both).
    expect(wait.mock.calls.map(([query]) => query)).toEqual([
      { replyToMessageId: "reply-1" },
      { threadId: "thread-1" },
      { tokenHash: "token-1" },
      { externalConversationId: "conversation-1" },
    ]);
  });
});
