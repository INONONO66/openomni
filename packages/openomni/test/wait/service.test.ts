import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Wait } from "@openomni/protocol";
import { Bus, Storage, WaitStore } from "@openomni/session";
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
    const record = WaitService.open(buildWaitCreate("wait-open"));

    expect(WaitStore.get("wait-open")).toEqual(record);
    const duplicate = (() => {
      try {
        WaitService.open(buildWaitCreate("wait-open-2", { originMessageId: "out-wait-open" }));
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
    );

    const attached = WaitService.attachReply("wait-reply", {
      replyKey: "inbound-1",
      responderCandidates: ["actor-a"],
      at: 1_000,
    });
    const resolved = WaitService.attachReply("wait-reply", {
      replyKey: "inbound-2",
      responderCandidates: ["actor-b"],
      at: 2_000,
    });

    expect(attached.kind).toBe("attached");
    expect(resolved.kind).toBe("resolved");
    expect(WaitStore.get("wait-reply")?.status).toBe("resolved");
    expect(WaitStore.get("wait-reply")?.ownerRef).toEqual({
      kind: "session",
      id: "session-wait-reply",
    });
  });

  test("zero matcher candidates fold to a typed unknown_responder rejection", () => {
    WaitService.open(buildWaitCreate("wait-unknown"));

    const outcome = WaitService.attachReply("wait-unknown", {
      replyKey: "inbound-unknown",
      responderCandidates: [],
      at: 1_000,
    });

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
    );
    WaitService.open(buildWaitCreate("wait-untouched", { originMessageId: "out-untouched" }));
    WaitService.attachReply("wait-partial", {
      replyKey: "inbound-1",
      responderCandidates: ["actor-a"],
      at: 1_000,
    });

    const expired = WaitService.sweepExpired(10_001);

    expect(expired.map((record) => record.id)).toEqual(["wait-partial"]);
    expect(WaitStore.get("wait-partial")).toMatchObject({ status: "expired", partial: true });
    expect(WaitStore.get("wait-untouched")?.status).toBe("open");
    await flushBus();
    expect(events).toContainEqual({ name: "wait.expired", partial: true });
  });

  test("auditSyncAsk publishes the audit event and never writes a Wait row", async () => {
    const phases: string[] = [];
    Bus.observe((event, payload) => {
      if (event.name !== "wait.sync_ask") return;
      phases.push((payload as { phase: string }).phase);
    });

    WaitService.auditSyncAsk({ dispatchId: "dispatch-1", sessionId: "ses-1", phase: "opened" });
    WaitService.auditSyncAsk({ dispatchId: "dispatch-1", sessionId: "ses-1", phase: "answered" });

    await flushBus();
    expect(phases).toEqual(["opened", "answered"]);
    expect(WaitStore.list()).toHaveLength(0);
  });
});
