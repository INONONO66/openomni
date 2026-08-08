import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Wait } from "@openomni/protocol";
import { Bus, Storage, WaitStore } from "../../src/index";
import {
  bareStorageAdapter,
  buildReplyInput,
  buildWaitCreate,
  captureStoreError,
} from "../helpers/wait";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

describe("WaitStore", () => {
  test("creates an open wait, persists it, and publishes wait.opened", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    const created = WaitStore.create(buildWaitCreate());
    const loaded = WaitStore.get("wait-1");

    expect(created.status).toBe("open");
    expect(created.revision).toBe(0);
    expect(created.partial).toBe(false);
    expect(loaded).toEqual(created);
    await flushBus();
    expect(events).toContain("wait.opened");
  });

  test("rejects a second wait for the same originMessageId with a typed duplicate error", () => {
    WaitStore.create(buildWaitCreate());

    const error = captureStoreError(() => WaitStore.create(buildWaitCreate({ id: "wait-2" })));

    expect(error.data.code).toBe("duplicate");
    expect(error.data.waitId).toBe("wait-2");
    expect(WaitStore.get("wait-2")).toBeUndefined();
  });

  test("rejects a duplicate wait id with a typed duplicate error", () => {
    WaitStore.create(buildWaitCreate());

    const error = captureStoreError(() =>
      WaitStore.create(buildWaitCreate({ originMessageId: "out-msg-2" })),
    );

    expect(error.data.code).toBe("duplicate");
  });

  test("finds open waits by scoped correlation and rejects other channels", () => {
    WaitStore.create(buildWaitCreate());

    expect(
      WaitStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          replyToMessageId: "reply-1",
        },
        1_000,
      ),
    ).toHaveLength(1);
    expect(
      WaitStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:other",
          replyToMessageId: "reply-1",
        },
        1_000,
      ),
    ).toHaveLength(0);
  });

  test("surfaces open-but-expired rows so the kernel can lazily expire them", () => {
    WaitStore.create(buildWaitCreate());

    // Deadline judgment is NOT a read-time filter: an open row past its
    // expiresAt still correlates, the fold rejects the reply as
    // deadline_passed, and the kernel folds the wait to expired. Silently
    // dropping it here would leak late replies into surface routing.
    const matches = WaitStore.findByCorrelation({ tokenHash: "tok-1" }, 10_001);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: "wait-1", status: "open" });
  });

  test("keeps resolved waits correlatable only inside the follow-up window", () => {
    WaitStore.create(buildWaitCreate({ resolutionPolicy: "first_reply", quorum: undefined }));
    const outcome = WaitStore.attachReply("wait-1", buildReplyInput());
    expect(outcome.kind).toBe("resolved");

    expect(WaitStore.findByCorrelation({ tokenHash: "tok-1" }, 2_000)).toHaveLength(1);
    expect(WaitStore.findByCorrelation({ tokenHash: "tok-1" }, 2_001)).toHaveLength(0);
  });

  test("persists fold outcomes through the revision CAS and publishes reply events", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate());

    const attached = WaitStore.attachReply("wait-1", buildReplyInput());
    const resolved = WaitStore.attachReply(
      "wait-1",
      buildReplyInput({ replyKey: "reply-key-2", responderCandidates: ["actor-b"], at: 2_000 }),
    );
    const persisted = WaitStore.get("wait-1");

    expect(attached.kind).toBe("attached");
    expect(resolved.kind).toBe("resolved");
    expect(persisted?.status).toBe("resolved");
    expect(persisted?.revision).toBe(2);
    expect(persisted?.replies).toHaveLength(2);
    expect(persisted?.resolvedAt).toBe(2_000);
    await flushBus();
    expect(events.filter((name) => name === "wait.reply_attached")).toHaveLength(2);
    expect(events).toContain("wait.resolved");
  });

  test("rejected replies write nothing and publish wait.reply_rejected", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate());
    WaitStore.attachReply("wait-1", buildReplyInput());

    const duplicate = WaitStore.attachReply(
      "wait-1",
      buildReplyInput({ responderCandidates: ["actor-b"], at: 2_000 }),
    );
    const ambiguous = WaitStore.attachReply(
      "wait-1",
      buildReplyInput({
        replyKey: "reply-key-3",
        responderCandidates: ["actor-b", "actor-c"],
        at: 2_100,
      }),
    );
    const persisted = WaitStore.get("wait-1");

    expect(duplicate.kind).toBe("rejected");
    if (duplicate.kind !== "rejected") throw new Error("expected rejected");
    expect(duplicate.code).toBe("duplicate_reply");
    expect(ambiguous.kind).toBe("rejected");
    if (ambiguous.kind !== "rejected") throw new Error("expected rejected");
    expect(ambiguous.code).toBe("ambiguous_responder");
    // Quorum unchanged: still the single attached reply at revision 1.
    expect(persisted?.revision).toBe(1);
    expect(persisted?.replies).toHaveLength(1);
    expect(persisted?.status).toBe("open");
    await flushBus();
    expect(events.filter((name) => name === "wait.reply_rejected")).toHaveLength(2);
  });

  test("expires a partially answered wait and persists partial: true", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate());
    WaitStore.attachReply("wait-1", buildReplyInput());

    const outcome = WaitStore.expire("wait-1", 10_001);
    const persisted = WaitStore.get("wait-1");

    expect(outcome.kind).toBe("expired");
    if (outcome.kind !== "expired") throw new Error("expected expired");
    expect(outcome.partial).toBe(true);
    expect(persisted?.status).toBe("expired");
    expect(persisted?.partial).toBe(true);
    expect(WaitStore.list(["expired"])).toHaveLength(1);
    await flushBus();
    expect(events).toContain("wait.expired");
  });

  test("recordDeliveryReceipt persists the re-keyed correlation projection through the CAS", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate());

    const outcome = WaitStore.recordDeliveryReceipt("wait-1", {
      externalMessageId: "platform:msg-1",
      at: 500,
    });
    const persisted = WaitStore.get("wait-1");

    expect(outcome.kind).toBe("delivery_recorded");
    expect(persisted?.correlation.replyToMessageId).toBe("platform:msg-1");
    expect(persisted?.revision).toBe(1);
    // The adapter's correlation projection columns moved with the record:
    // lookups answer the platform id and no longer the internal one.
    expect(WaitStore.findByCorrelation({ replyToMessageId: "platform:msg-1" }, 1_000)).toHaveLength(
      1,
    );
    expect(WaitStore.findByCorrelation({ replyToMessageId: "reply-1" }, 1_000)).toHaveLength(0);
    await flushBus();
    // Projection-only transition: no wait ledger event beyond wait.opened.
    expect(events).toEqual(["wait.opened"]);
  });

  test("a delivery receipt on a terminal wait rejects wait_terminal and writes nothing", () => {
    WaitStore.create(buildWaitCreate());
    WaitStore.cancel("wait-1", 400);

    const outcome = WaitStore.recordDeliveryReceipt("wait-1", {
      externalMessageId: "platform:msg-late",
      at: 500,
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    expect(outcome.code).toBe("wait_terminal");
    expect(WaitStore.get("wait-1")?.correlation.replyToMessageId).toBe("reply-1");
  });

  test("a concurrent write between read and CAS raises a typed revision_conflict", () => {
    WaitStore.create(buildWaitCreate());

    const error = captureStoreError(() =>
      WaitStore.transition("wait-1", (record) => {
        // Concurrent writer advances the revision after this step read it.
        WaitStore.cancel("wait-1", 500);
        return Wait.cancel(record, { at: 600 });
      }),
    );

    expect(error.data.code).toBe("revision_conflict");
    expect(error.data.waitId).toBe("wait-1");
    expect(WaitStore.get("wait-1")?.cancelledAt).toBe(500);
  });

  test("transition on a missing wait raises a typed not_found error", () => {
    const error = captureStoreError(() =>
      WaitStore.transition("wait-missing", (record) => Wait.cancel(record, { at: 1 })),
    );

    expect(error.data.code).toBe("not_found");
  });

  test("fails closed with a typed adapter_absent error when the wait sub-adapter is missing", () => {
    Storage.configure(bareStorageAdapter());

    const createError = captureStoreError(() => WaitStore.create(buildWaitCreate()));
    const readError = captureStoreError(() => WaitStore.get("wait-1"));

    expect(createError.data.code).toBe("adapter_absent");
    expect(readError.data.code).toBe("adapter_absent");
  });

  test("waits survive adapter reconfiguration on the same database", () => {
    const adapter = Storage.getAdapter();
    WaitStore.create(buildWaitCreate());

    Storage.configure(adapter);

    expect(WaitStore.get("wait-1")?.status).toBe("open");
  });
});
