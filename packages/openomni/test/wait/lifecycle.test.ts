import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Wait } from "@openomni/protocol";
import { Storage, WaitStore } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { WaitService } from "../../src/wait/index";
import { buildWaitCreate } from "../helpers/wait";

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("WaitService", () => {
  test("open records exactly one durable Wait for an awaited delivery", () => {
    const record = WaitService.open(buildWaitCreate("wait-open"), "trace-test");

    expect(WaitStore.get("wait-open")).toEqual(record);
    const duplicate = (() => {
      try {
        WaitService.open(
          buildWaitCreate("wait-open-2", { originMessageId: "out-wait-open" }),
          "trace-test",
        );
      } catch (error) {
        if (Wait.StoreError.isInstance(error)) return error;
        throw error;
      }
      throw new Error("expected duplicate WaitStoreError");
    })();
    expect(duplicate.data.code).toBe("duplicate");
  });

  test("attachReply applies the fold outcome and resolves the owner-correct wait", () => {
    WaitService.open(
      buildWaitCreate("wait-reply", {
        expectedResponders: ["actor-a", "actor-b"],
        resolutionPolicy: "quorum",
        quorum: { expected: 2, threshold: 2 },
      }),
      "trace-test",
    );

    const attached = WaitService.attachReply(
      "wait-reply",
      {
        replyKey: "inbound-1",
        responderCandidates: ["actor-a"],
        at: 1_000,
      },
      "trace-test",
    );
    const resolved = WaitService.attachReply(
      "wait-reply",
      {
        replyKey: "inbound-2",
        responderCandidates: ["actor-b"],
        at: 2_000,
      },
      "trace-test",
    );

    expect(attached.kind).toBe("attached");
    expect(resolved.kind).toBe("resolved");
    expect(WaitStore.get("wait-reply")?.status).toBe("resolved");
    expect(WaitStore.get("wait-reply")?.ownerRef).toEqual({
      kind: "session",
      id: "session-wait-reply",
    });
  });

  test("zero matcher candidates fold to a typed unknown_responder rejection", () => {
    WaitService.open(buildWaitCreate("wait-unknown"), "trace-test");

    const outcome = WaitService.attachReply(
      "wait-unknown",
      {
        replyKey: "inbound-unknown",
        responderCandidates: [],
        at: 1_000,
      },
      "trace-test",
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    expect(outcome.code).toBe("unknown_responder");
    expect(WaitStore.get("wait-unknown")?.replies).toHaveLength(0);
  });

  test("sweepExpired folds deadline-passed open waits and reports partial state", async () => {
    const events: { name: string; partial?: boolean }[] = [];
    Bus.observe((event, payload) =>
      events.push({
        name: event.name,
        ...(typeof payload === "object" && payload !== null && "partial" in payload
          ? { partial: Boolean((payload as { partial: unknown }).partial) }
          : {}),
      }),
    );
    WaitService.open(
      buildWaitCreate("wait-partial", {
        expectedResponders: ["actor-a", "actor-b", "actor-c"],
        resolutionPolicy: "quorum",
        quorum: { expected: 3, threshold: 2 },
        expiresAt: 10_000,
      }),
      "trace-test",
    );
    WaitService.open(
      buildWaitCreate("wait-untouched", { originMessageId: "out-untouched" }),
      "trace-test",
    );
    WaitService.attachReply(
      "wait-partial",
      {
        replyKey: "inbound-1",
        responderCandidates: ["actor-a"],
        at: 1_000,
      },
      "trace-test",
    );

    const expired = WaitService.sweepExpired("trace-test", 10_001);

    expect(expired.map((record) => record.id)).toEqual(["wait-partial"]);
    expect(WaitStore.get("wait-partial")).toMatchObject({ status: "expired", partial: true });
    expect(WaitStore.get("wait-untouched")?.status).toBe("open");
    await flushBus();
    expect(events).toContainEqual({ name: "wait.expired", partial: true });
  });

  test("sweepExpired isolates one corrupt wait: records Operational.Events.Error and keeps sweeping", async () => {
    const events: { name: string; msg?: string }[] = [];
    Bus.observe((event, payload) =>
      events.push({
        name: event.name,
        ...(typeof payload === "object" && payload !== null && "msg" in payload
          ? { msg: String((payload as { msg: unknown }).msg) }
          : {}),
      }),
    );
    WaitService.open(buildWaitCreate("wait-corrupt", { expiresAt: 10_000 }), "trace-test");
    WaitService.open(
      buildWaitCreate("wait-healthy", { originMessageId: "out-healthy", expiresAt: 10_000 }),
      "trace-test",
    );
    // Corrupt one wait's owner stream: an extra fact advances the head past
    // the projected revision, so its expiry transition hits a permanent
    // revision conflict.
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    const appended = ledger.append(
      { streamId: "wait:wait-corrupt", type: "wait.tampered", data: {} },
      1,
    );
    expect(appended.kind).toBe("appended");

    const expired = WaitService.sweepExpired("trace-test", 10_001);

    // One bad wait never kills the sweep (#510 review fix F3): the healthy
    // wait still folds and the corrupt one is recorded as an error.
    expect(expired.map((record) => record.id)).toEqual(["wait-healthy"]);
    expect(WaitStore.get("wait-healthy")?.status).toBe("expired");
    expect(WaitStore.get("wait-corrupt")?.status).toBe("open");
    await flushBus();
    expect(events).toContainEqual({
      name: "operational.error",
      msg: "wait expiry sweep failed for wait-corrupt",
    });
  });

  test("auditSyncAsk publishes the audit event and never writes a Wait row", async () => {
    const seen: Array<{ phase: string; traceId: string }> = [];
    Bus.observe((event, payload) => {
      if (event.name !== "wait.sync_ask") return;
      seen.push(payload as { phase: string; traceId: string });
    });

    WaitService.auditSyncAsk({
      dispatchId: "dispatch-1",
      traceId: "trace-sync-ask",
      sessionId: "ses-1",
      phase: "opened",
    });
    WaitService.auditSyncAsk({
      dispatchId: "dispatch-1",
      traceId: "trace-sync-ask",
      sessionId: "ses-1",
      phase: "answered",
    });

    await flushBus();
    // Pin (D11): the service publishes exactly the caller's trace (the
    // handler-level passthrough is pinned in dispatch-owners.test.ts).
    expect(seen.map((event) => event.phase)).toEqual(["opened", "answered"]);
    expect(seen.every((event) => event.traceId === "trace-sync-ask")).toBe(true);
    expect(WaitStore.list()).toHaveLength(0);
  });

  test("wait.sync_ask refuses an untraced payload", () => {
    const base = { dispatchId: "dispatch-1", sessionId: "ses-1", phase: "opened", time: 1 };
    expect(Wait.Events.SyncAsk.schema.safeParse(base).success).toBe(false);
    expect(Wait.Events.SyncAsk.schema.safeParse({ ...base, traceId: "" }).success).toBe(false);
    expect(Wait.Events.SyncAsk.schema.safeParse({ ...base, traceId: "trace-1" }).success).toBe(
      true,
    );
  });
});
