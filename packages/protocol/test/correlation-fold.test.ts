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
