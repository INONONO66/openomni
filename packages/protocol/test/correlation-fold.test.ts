import { describe, expect, test } from "bun:test";
import { Wait } from "../src/wait/index.js";
import type * as Schema from "../src/wait/schema.js";

const pins = { endpointId: "ep-1", channelId: "ch-1" } as const;

const record = (over: Partial<Schema.Record> = {}): Schema.Record =>
  ({
    id: "w-1",
    expectedResponders: ["seller-1"],
    correlation: {},
    allowedActions: ["report_result"],
    ...over,
  }) as Schema.Record;

describe("Wait.waitTierLevels — precedence order", () => {
  test("emits levels in replyTo → thread → tokenHash → externalConversationId order", () => {
    const levels = Wait.waitTierLevels({
      replyToMessageId: "m-1",
      threadId: "th-1",
      tokenHash: "tk-1",
      ...pins,
    });
    expect(levels).toEqual([
      { replyToMessageId: "m-1" },
      { threadId: "th-1" },
      { tokenHash: "tk-1" },
      pins,
    ]);
  });

  test("externalConversationId replaces the scoped-pin fallback (mutually exclusive)", () => {
    expect(Wait.waitTierLevels({ externalConversationId: "cv-1", ...pins })).toEqual([
      { externalConversationId: "cv-1" },
    ]);
  });

  test("no pins and no signals → no levels (nothing to correlate on)", () => {
    expect(Wait.waitTierLevels({})).toEqual([]);
  });
});

describe("Wait.waitPinsAllowClaim — channel always, endpoint only single-responder", () => {
  test("channel mismatch always excludes", () => {
    expect(
      Wait.waitPinsAllowClaim(record({ correlation: { channelId: "ch-OTHER" } }), {
        channelId: "ch-1",
        endpointId: "ep-1",
      }),
    ).toBe(false);
  });

  test("single-responder: endpoint mismatch excludes", () => {
    expect(
      Wait.waitPinsAllowClaim(
        record({ expectedResponders: ["a"], correlation: { endpointId: "ep-OTHER" } }),
        { endpointId: "ep-1", channelId: "ch-1" },
      ),
    ).toBe(false);
  });

  test("multi-responder: endpoint mismatch is TOLERATED (others reply from own endpoints)", () => {
    expect(
      Wait.waitPinsAllowClaim(
        record({ expectedResponders: ["a", "b"], correlation: { endpointId: "ep-DELIVERY" } }),
        { endpointId: "ep-b", channelId: "ch-1" },
      ),
    ).toBe(true);
  });
});

describe("Wait.legacyTierLevels — frozen-store fallback queries", () => {
  test("builds endpoint+channel-scoped queries per signal, both stores", () => {
    const levels = Wait.legacyTierLevels({ correlation: { replyToMessageId: "m-1", ...pins } });
    expect(levels[0]?.pendingInteraction).toEqual([{ ...pins, replyToMessageId: "m-1" }]);
    expect(levels[0]?.pendingAsk).toEqual([{ ...pins, replyToMessageId: "m-1" }]);
  });

  test("externalMessageId adds a PendingAsk-ONLY fallback (never PendingInteraction)", () => {
    const levels = Wait.legacyTierLevels({
      correlation: { ...pins },
      externalMessageId: "x-1",
    });
    const last = levels.at(-1);
    expect(
      last?.pendingAsk.some((q) => "externalMessageId" in q && q.externalMessageId === "x-1"),
    ).toBe(true);
    expect(last?.pendingInteraction.some((q) => "externalMessageId" in q)).toBe(false);
  });

  test("no scope pins → no legacy level reached (parsed envelopes always have pins)", () => {
    expect(Wait.legacyTierLevels({ correlation: { replyToMessageId: "m-1" } })).toEqual([]);
  });

  test("dispatch-seam input (no externalMessageId) is inert on that branch — identical to pins-only", () => {
    const withField = Wait.legacyTierLevels({ correlation: { ...pins } });
    const withoutField = Wait.legacyTierLevels({
      correlation: { ...pins },
      externalMessageId: undefined,
    });
    expect(withField).toEqual(withoutField);
  });
});
