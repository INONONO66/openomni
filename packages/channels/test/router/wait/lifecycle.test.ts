import { beforeEach, describe, expect, test } from "bun:test";
import { Wait } from "@openomni/protocol";
import { Storage, WaitStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { WaitService } from "../../../src/router/wait/index";
import { buildWaitCreate } from "../../helpers/wait";
import { resetStores } from "../_router-fixture";

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

beforeEach(resetStores);

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

  test("cancel folds an open wait to its durable terminal state", () => {
    WaitService.open(buildWaitCreate("wait-cancel"), "trace-test");

    const outcome = WaitService.cancel("wait-cancel", "trace-test", 2_000);

    expect(outcome.kind).toBe("cancelled");
    expect(WaitStore.get("wait-cancel")).toMatchObject({ status: "cancelled", updatedAt: 2_000 });
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

    const expired = WaitService.sweepExpired("trace-test", Bus.publish, 10_001);

    expect(expired.map((record) => record.id)).toEqual(["wait-partial"]);
    expect(WaitStore.get("wait-partial")).toMatchObject({ status: "expired", partial: true });
    expect(WaitStore.get("wait-untouched")?.status).toBe("open");
    await flushBus();
    expect(events).toContainEqual({ name: "wait.expired", partial: true });
  });

  test("sweepExpired expires a wait at exactly its deadline (inclusive boundary)", () => {
    // Deadline contract: expired when now >= deadline. The sweep guard must
    // share the fold's boundary — a sweep at now === expiresAt expires the
    // wait instead of leaving it for the next tick.
    WaitService.open(
      buildWaitCreate("wait-boundary", { originMessageId: "out-boundary", expiresAt: 10_000 }),
      "trace-test",
    );

    const expired = WaitService.sweepExpired("trace-test", Bus.publish, 10_000);

    expect(expired.map((record) => record.id)).toEqual(["wait-boundary"]);
    expect(WaitStore.get("wait-boundary")?.status).toBe("expired");
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

    const expired = WaitService.sweepExpired("trace-test", Bus.publish, 10_001);

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
});
