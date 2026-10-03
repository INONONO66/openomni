import { expect, test } from "bun:test";
import { Inbox, Journal } from "@openomni/protocol";
import { deliveryActions, receivedMessageAction } from "../src/core/commit";

/**
 * #1252 input admission: delivered inputs are journal rows of the closed set —
 * `prompt` rows carry `delivery: steer|followUp` (default `followUp`), control
 * inputs (interrupt/resume) are `signal` rows — and each produced row passes
 * its kind's declared schema.
 */

function row(kind: Inbox.Kind, id: string): Inbox.Row {
  return Inbox.Row.parse({
    id,
    sessionId: "s1",
    kind,
    content: "payload",
    origin: { encodingVersion: 1, value: { channel: "test" } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: 10,
    ordinal: 1,
  });
}

test("a delivered prompt is a prompt row with delivery defaulting to followUp", () => {
  const [action] = deliveryActions([row("prompt", "in-1")], { kind: "turn", turnId: "t1" }, "before_llm", null);
  if (action === undefined) throw new Error("missing delivery action");
  expect(action.kind).toBe("prompt");
  expect(action.intent.value).toEqual({ inboxId: "in-1", delivery: "followUp" });
  expect(Journal.declarationFor("prompt")?.schema.safeParse({ intent: action.intent, effect: action.effect }).success).toBe(true);
});

test("control inputs deliver as signal rows, never as turn inputs of the prompt kind", () => {
  for (const control of ["interrupt", "resume"] as const) {
    const [action] = deliveryActions([row(control, `in-${control}`)], { kind: "inbox" }, "before_llm", null);
    if (action === undefined) throw new Error("missing delivery action");
    expect(action.kind).toBe("signal");
    expect(action.intent.value).toEqual({ inboxId: `in-${control}`, control });
    expect(Journal.declarationFor("signal")?.schema.safeParse({ intent: action.intent, effect: action.effect }).success).toBe(true);
  }
});

test("admission rows split the same way: prompt stays prompt, control admits as signal", () => {
  const admit = (kind: Inbox.Kind) =>
    receivedMessageAction({
      id: `adm-${kind}`,
      sessionId: "s1",
      kind,
      content: "payload",
      origin: { encodingVersion: 1, value: { channel: "test" } },
      parentActionId: null,
      at: 10,
    });
  expect(admit("prompt").kind).toBe("prompt");
  expect(admit("interrupt").kind).toBe("signal");
  expect(admit("resume").kind).toBe("signal");
  // The delivery vocabulary itself is closed: steer|followUp only.
  const declaration = Journal.declarationFor("prompt");
  const base = admit("prompt");
  expect(
    declaration?.schema.safeParse({
      intent: { encodingVersion: 1, value: { delivery: "steer" } },
      effect: base.effect,
    }).success,
  ).toBe(true);
  expect(
    declaration?.schema.safeParse({
      intent: { encodingVersion: 1, value: { delivery: "immediately" } },
      effect: base.effect,
    }).success,
  ).toBe(false);
});
