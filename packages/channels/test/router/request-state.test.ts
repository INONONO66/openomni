import { afterEach, beforeEach, expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { SessionTransition } from "@openomni/protocol";
import { answer, command, openRequest, requestPort } from "../helpers/requests";
import { requestFixture } from "../helpers/request-record";

beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());

test.each([
  "first",
  "quorum",
  "all",
] as const)("%s resolves only at its distinct-responder threshold", async (resolution) => {
  const threshold = resolution === "first" ? 1 : resolution === "quorum" ? 2 : 3;
  await openRequest("original", { expectedResponders: ["a", "b", "c"], resolution, threshold });
  for (const [index, responder] of ["a", "b", "c"].slice(0, threshold).entries()) {
    expect(await answer("original", responder, `reply-${index}`, 2 + index)).toBe(
      index + 1 === threshold ? "resolved" : "attached",
    );
  }
  const stored = SessionHandleStore.requestById("original");
  expect(stored?.replies).toHaveLength(threshold);
  expect(stored?.sessionId).toBe("request-owner");
  expect(
    SessionHandleStore.tree("request-owner").filter(
      (action) => action.id === "original:resolution",
    ),
  ).toHaveLength(1);
});

test("same reply and same responder never advance the request twice", async () => {
  await openRequest("original", {
    expectedResponders: ["a", "b"],
    resolution: "all",
    threshold: 2,
  });
  expect(await answer("original", "a", "reply-a", 2)).toBe("attached");
  const before = SessionHandleStore.tree("request-owner");
  expect(await answer("original", "a", "reply-a", 2)).toBe("attached");
  expect(SessionHandleStore.tree("request-owner")).toEqual(before);
  expect(await answer("original", "a", "reply-a-new", 3)).toBe("duplicate");
  expect(SessionHandleStore.requestById("original")?.replies).toHaveLength(1);
});

test("unknown responder is rejected without attaching", async () => {
  await openRequest("original");
  expect(await answer("original", "stranger", "reply", 2)).toBe("rejected");
  expect(SessionHandleStore.requestById("original")?.replies).toEqual([]);
});

test.each([0, 1])("timeout keeps %s partial replies in original action history", async (count) => {
  await openRequest("original", {
    expectedResponders: ["a", "b"],
    resolution: "all",
    threshold: 2,
    deadline: 10,
  });
  if (count) await answer("original", "a", "early", 2);
  expect(
    command("original", { kind: "request.timeout", requestId: "original" }, 9).resolution,
  ).toBe("rejected");
  expect(
    command("original", { kind: "request.timeout", requestId: "original" }, 10).resolution,
  ).toBe("expired");
  expect(SessionHandleStore.requestById("original")).toMatchObject({
    state: "expired",
    outcome: "outcome_unknown",
  });
  expect(SessionHandleStore.requestById("original")?.replies).toHaveLength(count);
});

test("cancellation preserves partial replies and cannot be reversed by late input", async () => {
  await openRequest("original", {
    expectedResponders: ["a", "b"],
    resolution: "all",
    threshold: 2,
  });
  await answer("original", "a", "early", 2);
  expect(
    command(
      "original",
      {
        kind: "request.cancel",
        requestId: "original",
        principal: { kind: "actor", principalId: "a", evidenceId: "external" },
      },
      3,
    ).resolution,
  ).toBe("rejected");
  expect(
    command(
      "original",
      {
        kind: "request.cancel",
        requestId: "original",
        principal: { kind: "session", principalId: "request-owner", evidenceId: "session" },
      },
      4,
    ).resolution,
  ).toBe("cancelled");
  expect(await answer("original", "b", "late", 5)).toBe("duplicate");
  expect(SessionHandleStore.requestById("original")).toMatchObject({
    state: "cancelled",
    replies: [{ replyId: "early" }],
  });
});

test.each([10, 11])("answer at %s cannot cross the deadline", async (at) => {
  await openRequest("original", { deadline: 10 });
  expect(await answer("original", "actor-external-worker", "late", at)).toBe("late_unknown");
  expect(SessionHandleStore.requestById("original")?.replies).toEqual([]);
  expect(SessionHandleStore.requestById("original")?.state).toBe("expired");
});

test("resolved request cannot reopen for supplementary replies", async () => {
  await openRequest("original");
  expect(await answer("original", "actor-external-worker", "first", 2)).toBe("resolved");
  expect(await answer("original", "actor-external-worker", "second", 3)).toBe("duplicate");
  expect(SessionHandleStore.requestById("original")?.replies).toHaveLength(1);
});

test.each([
  "accepted",
  "rejected",
  "unknown",
] as const)("physical %s receipt preserves its value in request action history", async (value) => {
  await openRequest("original");
  const port = requestPort();
  const receipt = {
    inputId: "receipt",
    requestId: "original",
    sessionId: "request-owner",
    sourceActionId: "original",
    externalMessageId: "platform",
    value,
    at: 2,
  };
  await port.receipt(receipt);
  const before = SessionHandleStore.tree("request-owner");
  await port.receipt(receipt);
  expect(SessionHandleStore.tree("request-owner")).toEqual(before);
  expect(
    before.find((action) => action.id === "original:input:receipt")?.effect.value,
  ).toMatchObject({ receipt });
  expect(SessionHandleStore.requestById("original")?.correlation.replyToMessageId).toBe("platform");
  expect(SessionHandleStore.requestById("original")?.state).toBe("open");
});

test.each([
  { expectedResponders: ["a", "a"] },
  { resolution: "quorum", threshold: 2 },
  { resolution: "all", expectedResponders: ["a", "b"], threshold: 1 },
  { resolution: "first", threshold: 2 },
  { state: "resolved", outcome: null },
] as const)("request schema rejects incoherent bounds or terminal state %#", (overrides) => {
  expect(SessionTransition.Request.safeParse({ ...requestFixture(), ...overrides }).success).toBe(
    false,
  );
});
