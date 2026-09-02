import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Trigger } from "@openomni/protocol";
import { Session, Storage } from "../../src/index";

const OWNER = "session-owner";
const FIRE_ID = "fire-1";
const PAYLOAD = "[Trigger fire]\nResident-authored intent:\nsummarize the build";
const DIGEST = `sha256:${"a".repeat(64)}` as Trigger.CanonicalDigest;
const AT = 1_700_000_000_000;

function admit(overrides: Partial<Parameters<typeof Session.admitInternalTrigger>[0]> = {}) {
  return Session.admitInternalTrigger({
    sessionId: OWNER,
    fireId: FIRE_ID,
    payload: PAYLOAD,
    payloadDigest: DIGEST,
    admittedAt: AT,
    ...overrides,
  });
}

function openOwnerSession(): void {
  Session.materialize({
    id: OWNER,
    traceId: "trace-owner",
    title: "Resident chat",
    model: { providerID: "test", modelID: "test-model" },
  });
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

describe("Session.admitInternalTrigger — the durable gate an ack depends on", () => {
  test("admits one Fire into its owner transcript as a system-attributed user turn", () => {
    openOwnerSession();

    const receipt = admit();

    // The message id is derived from the Fire, which is what makes the
    // admission idempotent without a separate dedupe index.
    expect(receipt).toEqual({
      fireId: FIRE_ID,
      sessionId: OWNER,
      messageId: `trigger-fire:${FIRE_ID}`,
      payloadDigest: DIGEST,
      admittedAt: AT,
    });

    const messages = Session.getMessages(OWNER);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message === undefined) throw new Error("expected the admitted message");
    expect(message.id).toBe(`trigger-fire:${FIRE_ID}`);
    // A Fire reads as a user turn so the Resident answers it, but it is stamped
    // `trigger.fire` so it is never mistaken for something the Owner typed.
    expect(message.role).toBe("user");
    expect(message.role === "user" ? message.system : undefined).toBe("trigger.fire");

    const parts = Session.getParts(message.id);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("text");
    // The payload lands verbatim: the rendering decision belongs upstream.
    expect(parts[0]?.type === "text" ? parts[0].text : undefined).toBe(PAYLOAD);
  });

  test("re-admitting the same Fire returns the original receipt and writes nothing new", () => {
    openOwnerSession();
    const first = admit();

    // A Fire that crashed between admission and acknowledgement is replayed by
    // the next boot; it must not be told to the Owner twice.
    const second = admit({ admittedAt: AT + 5_000 });

    expect(second.messageId).toBe(first.messageId);
    expect(Session.getMessages(OWNER)).toHaveLength(1);
    expect(Session.getParts(first.messageId)).toHaveLength(1);
  });

  test("a missing owner session is refused rather than resurrected", () => {
    // No session is materialized: the transcript this Fire was authored against
    // is gone.
    let refusal: unknown;
    try {
      admit();
    } catch (error) {
      refusal = error;
    }

    expect(Trigger.StoreError.isInstance(refusal)).toBe(true);
    // Materializing a replacement here would let a Trigger create sessions and
    // deliver into a transcript its author never saw.
    expect(Trigger.StoreError.isInstance(refusal) ? refusal.data.code : undefined).toBe(
      "owner_session_missing",
    );
    expect(Trigger.StoreError.isInstance(refusal) ? refusal.data.fireId : undefined).toBe(FIRE_ID);
  });

  test("two different Fires in one session admit as two distinct turns", () => {
    openOwnerSession();

    const first = admit();
    const second = admit({ fireId: "fire-2", payload: "second fire", admittedAt: AT + 1_000 });

    expect(second.messageId).not.toBe(first.messageId);
    expect(Session.getMessages(OWNER)).toHaveLength(2);
  });

  test("a malformed admission is refused by the receipt schema before any write", () => {
    openOwnerSession();

    expect(() => admit({ payloadDigest: "not-a-digest" as Trigger.CanonicalDigest })).toThrow();
    // The refusal happened before the transcript was touched.
    expect(Session.getMessages(OWNER)).toEqual([]);
  });
});
