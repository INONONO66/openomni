import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ActorRegistry, Bus, Storage, WaitStore } from "@openomni/session";
import {
  SendInput,
  createExistingAgentMessaging,
  type OutboundMessage,
  type SenderTargetGrant,
} from "../../src/messaging/index.js";
import {
  buildAwaitedSendInput,
  buildGrant,
  buildSendInput,
  messagingNow,
  registerAgentFixture,
} from "../helpers/messaging.js";

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

let deliveries: OutboundMessage[];
let grants: SenderTargetGrant[];

function messaging() {
  return createExistingAgentMessaging({
    deliver: (message) => deliveries.push(message),
    grants: () => grants,
  });
}

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  deliveries = [];
  grants = [buildGrant("grant:sender->target")];
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("sender-target grant (policy plane)", () => {
  test("send without any covering grant is denied ungranted and delivers nothing", async () => {
    grants = [];
    const audits: { code: string; time: number }[] = [];
    Bus.observe((event, payload) => {
      if (event.name !== "messaging.denied") return;
      const data = payload as { code: string; time: number };
      audits.push({ code: data.code, time: data.time });
    });

    const receipt = messaging().send(buildSendInput());

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
    expect(deliveries).toHaveLength(0);
    expect(WaitStore.list()).toHaveLength(0);
    await flushBus();
    expect(audits).toEqual([{ code: "ungranted", time: messagingNow }]);
  });

  test("a grant bounds the operation: fire_and_forget-only grant denies awaited delivery", () => {
    grants = [buildGrant("grant:notify-only", { operations: ["fire_and_forget"] })];

    const receipt = messaging().send(buildAwaitedSendInput());

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
    expect(WaitStore.list()).toHaveLength(0);
  });

  test("an expired grant is not active — time is an input, denial is ungranted", () => {
    grants = [buildGrant("grant:expired", { expiresAt: messagingNow - 1 })];

    const receipt = messaging().send(buildSendInput());

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
  });
});

describe("explicit target resolution (fail closed)", () => {
  test("grant evaluation precedes target resolution: an ungranted sender learns nothing from the registry", () => {
    const receipt = messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } }));

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
  });

  test("granted but unregistered target actor is denied target_missing", () => {
    grants = [buildGrant("grant:ghost", { targetActorId: "actor:ghost" })];

    const receipt = messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } }));

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_missing");
    expect(deliveries).toHaveLength(0);
  });

  test("actor without any allocated endpoint is denied target_stale", () => {
    grants = [buildGrant("grant:endpointless", { targetActorId: "actor:endpointless" })];
    registerAgentFixture("actor:endpointless");

    const receipt = messaging().send(buildSendInput({ target: { actorId: "actor:endpointless" } }));

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_stale");
  });

  test("pinned endpoint that no longer exists is denied target_stale", () => {
    const receipt = messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:gone" } }),
    );

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_stale");
  });

  test("pinned endpoint re-bound to another actor is denied target_stale", () => {
    registerAgentFixture("actor:other", [{ id: "endpoint:other", externalId: "other-1" }]);

    const receipt = messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:other" } }),
    );

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_stale");
  });

  test("multi-endpoint actor without a pin is denied target_ambiguous; a pin resolves it", () => {
    ActorRegistry.registerEndpoint({
      id: "endpoint:target-b",
      actorId: "actor:target",
      channel: "qa",
      externalId: "target-2",
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });

    const unpinned = messaging().send(buildSendInput());
    const pinned = messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:target-b" } }),
    );

    expect(unpinned.kind).toBe("denied");
    if (unpinned.kind !== "denied") throw new Error("expected denial");
    expect(unpinned.code).toBe("target_ambiguous");
    expect(pinned.kind).toBe("sent");
    if (pinned.kind !== "sent") throw new Error("expected sent");
    expect(pinned.target.endpointId).toBe("endpoint:target-b");
    expect(deliveries).toHaveLength(1);
  });
});

describe("fire-and-forget delivery", () => {
  test("records one sent audit and creates NO Wait", async () => {
    const audits: { operation: string; waitId?: string; grantId: string }[] = [];
    Bus.observe((event, payload) => {
      if (event.name !== "messaging.sent") return;
      const data = payload as { operation: string; waitId?: string; grantId: string };
      audits.push({
        operation: data.operation,
        grantId: data.grantId,
        ...(data.waitId === undefined ? {} : { waitId: data.waitId }),
      });
    });

    const receipt = messaging().send(buildSendInput());

    expect(receipt.kind).toBe("sent");
    if (receipt.kind !== "sent") throw new Error("expected sent");
    expect(receipt.operation).toBe("fire_and_forget");
    expect(receipt.target).toEqual({
      actorId: "actor:target",
      endpointId: "endpoint:target",
      channel: "qa",
      externalId: "target-1",
    });
    expect(WaitStore.list()).toHaveLength(0);
    expect(deliveries).toEqual([
      {
        messageId: "message:test",
        senderId: "actor:sender",
        operation: "fire_and_forget",
        body: "test message",
        target: receipt.target,
      },
    ]);
    await flushBus();
    expect(audits).toEqual([{ operation: "fire_and_forget", grantId: "grant:sender->target" }]);
  });

  test("fire_and_forget carrying a waitSpec is a schema violation, not a silent Wait", () => {
    const result = SendInput.safeParse(buildAwaitedSendInput({ operation: "fire_and_forget" }));

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected schema rejection");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "fire_and_forget never opens a Wait — waitSpec is not allowed",
    );
  });
});

describe("awaited delivery", () => {
  test("appends exactly one owner-correct Wait with correlation, responders, policy, and deadline", () => {
    const receipt = messaging().send(buildAwaitedSendInput());

    expect(receipt.kind).toBe("sent");
    if (receipt.kind !== "sent" || receipt.operation !== "awaited") {
      throw new Error("expected awaited sent receipt");
    }
    const stored = WaitStore.get("wait:test-awaited");
    expect(stored).toEqual(receipt.wait);
    expect(stored).toMatchObject({
      ownerRef: { kind: "session", id: "session:owner" },
      originMessageId: "message:test-awaited",
      correlation: {
        endpointId: "endpoint:target",
        replyToMessageId: "message:test-awaited",
      },
      expectedResponders: ["actor:responder-1", "actor:responder-2", "actor:responder-3"],
      resolutionPolicy: "quorum",
      quorum: { expected: 3, threshold: 2 },
      status: "open",
      expiresAt: messagingNow + 600_000,
      createdAt: messagingNow,
    });
    expect(WaitStore.list()).toHaveLength(1);
    expect(deliveries[0]?.waitId).toBe("wait:test-awaited");
  });

  test("a second awaited send for the same message is denied wait_duplicate with an audit event", async () => {
    const audits: string[] = [];
    Bus.observe((event, payload) => {
      if (event.name !== "messaging.denied") return;
      audits.push((payload as { code: string }).code);
    });
    messaging().send(buildAwaitedSendInput());

    const secondSpec = buildAwaitedSendInput().waitSpec;
    if (secondSpec === undefined) throw new Error("awaited fixture must carry a waitSpec");
    const duplicate = messaging().send(
      buildAwaitedSendInput({
        waitSpec: { ...secondSpec, waitId: "wait:test-awaited-2" },
      }),
    );

    expect(duplicate.kind).toBe("denied");
    if (duplicate.kind !== "denied") throw new Error("expected denial");
    expect(duplicate.code).toBe("wait_duplicate");
    expect(WaitStore.list()).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    await flushBus();
    expect(audits).toEqual(["wait_duplicate"]);
  });

  test("awaited without a waitSpec is a schema violation owned by the SendInput refinement", () => {
    const result = SendInput.safeParse(buildSendInput({ operation: "awaited" }));

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected schema rejection");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "awaited operation requires a waitSpec",
    );
  });
});
