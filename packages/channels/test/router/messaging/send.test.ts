import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Gateway } from "@openomni/protocol";
import { ActorRegistry, Storage, WaitStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  createExistingAgentMessaging,
  type OutboundMessage,
} from "../../../src/router/messaging/send.js";
import {
  buildAwaitedSendInput,
  buildGrant,
  buildSendInput,
  messagingNow,
  registerAgentFixture,
} from "../../helpers/messaging.js";

const SendInput = Gateway.SendInput;
type SenderTargetGrant = Gateway.SenderTargetGrant;

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

let deliveries: OutboundMessage[];
let grants: SenderTargetGrant[];

function messaging() {
  return createExistingAgentMessaging({
    deliver: (message) => {
      deliveries.push(message);
    },
    grants: () => grants,
    publish: Bus.publish,
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
    const audits: { code: string; time: number; traceId: string }[] = [];
    Bus.observe((event, payload) => {
      if (event.name !== "messaging.denied") return;
      const data = payload as { code: string; time: number; traceId: string };
      audits.push({ code: data.code, time: data.time, traceId: data.traceId });
    });

    const receipt = await messaging().send(buildSendInput());

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
    expect(deliveries).toHaveLength(0);
    expect(WaitStore.list()).toHaveLength(0);
    await flushBus();
    // Pin (D11): the denial audit inherits the send input's trace.
    expect(audits).toEqual([{ code: "ungranted", time: messagingNow, traceId: "trace-messaging" }]);
  });

  test("a grant bounds the operation: fire_and_forget-only grant denies awaited delivery", async () => {
    grants = [buildGrant("grant:notify-only", { operations: ["fire_and_forget"] })];

    const receipt = await messaging().send(buildAwaitedSendInput());

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
    expect(WaitStore.list()).toHaveLength(0);
  });

  test("an expired grant is not active — time is an input, denial is ungranted", async () => {
    grants = [buildGrant("grant:expired", { expiresAt: messagingNow - 1 })];

    const receipt = await messaging().send(buildSendInput());

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
  });
});

describe("explicit target resolution (fail closed)", () => {
  test("grant evaluation precedes target resolution: an ungranted sender learns nothing from the registry", async () => {
    const receipt = await messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } }));

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
  });

  test("granted but unregistered target actor is denied target_missing", async () => {
    grants = [buildGrant("grant:ghost", { targetActorId: "actor:ghost" })];

    const receipt = await messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } }));

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_missing");
    expect(deliveries).toHaveLength(0);
  });

  test("actor without any allocated endpoint is denied target_stale", async () => {
    grants = [buildGrant("grant:endpointless", { targetActorId: "actor:endpointless" })];
    registerAgentFixture("actor:endpointless");

    const receipt = await messaging().send(
      buildSendInput({ target: { actorId: "actor:endpointless" } }),
    );

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_stale");
  });

  test("pinned endpoint that no longer exists is denied target_stale", async () => {
    const receipt = await messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:gone" } }),
    );

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_stale");
  });

  test("pinned endpoint re-bound to another actor is denied target_stale", async () => {
    registerAgentFixture("actor:other", [{ id: "endpoint:other", externalId: "other-1" }]);

    const receipt = await messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:other" } }),
    );

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_stale");
  });

  test("multi-endpoint actor without a pin is denied target_ambiguous; a pin resolves it", async () => {
    ActorRegistry.registerEndpoint({
      id: "endpoint:target-b",
      actorId: "actor:target",
      channel: "qa",
      externalId: "target-2",
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });

    const unpinned = await messaging().send(buildSendInput());
    const pinned = await messaging().send(
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
    const audits: { operation: string; waitId?: string; grantId: string; traceId: string }[] = [];
    Bus.observe((event, payload) => {
      if (event.name !== "messaging.sent") return;
      const data = payload as {
        operation: string;
        waitId?: string;
        grantId: string;
        traceId: string;
      };
      audits.push({
        operation: data.operation,
        grantId: data.grantId,
        traceId: data.traceId,
        ...(data.waitId === undefined ? {} : { waitId: data.waitId }),
      });
    });

    const receipt = await messaging().send(buildSendInput());

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
    expect(audits).toEqual([
      // Pin (D11): the sent audit inherits the send input's trace.
      { operation: "fire_and_forget", grantId: "grant:sender->target", traceId: "trace-messaging" },
    ]);
  });

  test("fire_and_forget carrying a waitSpec is a schema violation, not a silent Wait", async () => {
    const result = SendInput.safeParse(buildAwaitedSendInput({ operation: "fire_and_forget" }));

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected schema rejection");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "fire_and_forget never opens a Wait — waitSpec is not allowed",
    );
  });
});

describe("awaited delivery", () => {
  test("appends exactly one owner-correct Wait with correlation, responders, policy, and deadline", async () => {
    const receipt = await messaging().send(buildAwaitedSendInput());

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
    await messaging().send(buildAwaitedSendInput());

    const secondSpec = buildAwaitedSendInput().waitSpec;
    if (secondSpec === undefined) throw new Error("awaited fixture must carry a waitSpec");
    const duplicate = await messaging().send(
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

  test("awaited without a waitSpec is a schema violation owned by the SendInput refinement", async () => {
    const result = SendInput.safeParse(buildSendInput({ operation: "awaited" }));

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected schema rejection");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "awaited operation requires a waitSpec",
    );
  });
});

describe("delivery receipt", () => {
  test("a platform message id from the owner re-keys the wait correlation to it", async () => {
    const withReceipt = createExistingAgentMessaging({
      deliver: () => ({ externalMessageId: "platform:msg-77" }),
      grants: () => grants,
      publish: Bus.publish,
    });

    const receipt = await withReceipt.send(buildAwaitedSendInput());

    expect(receipt.kind).toBe("sent");
    if (receipt.kind !== "sent" || receipt.operation !== "awaited") {
      throw new Error("expected awaited sent receipt");
    }
    // The send receipt carries the receipt-updated record (revision bumped
    // from 1 at create — head === revision on the owner stream, #510).
    expect(receipt.wait.correlation.replyToMessageId).toBe("platform:msg-77");
    expect(receipt.wait.revision).toBe(2);
    const stored = WaitStore.get("wait:test-awaited");
    expect(stored?.correlation.replyToMessageId).toBe("platform:msg-77");
    // Correlation now answers the platform id, not the internal message id.
    expect(
      WaitStore.findByCorrelation({ replyToMessageId: "platform:msg-77" }, messagingNow),
    ).toHaveLength(1);
    expect(
      WaitStore.findByCorrelation({ replyToMessageId: "message:test-awaited" }, messagingNow),
    ).toHaveLength(0);
  });

  test("no receipt from the owner leaves the internal-id correlation unchanged", async () => {
    const receipt = await messaging().send(buildAwaitedSendInput());

    expect(receipt.kind).toBe("sent");
    if (receipt.kind !== "sent" || receipt.operation !== "awaited") {
      throw new Error("expected awaited sent receipt");
    }
    expect(receipt.wait.correlation.replyToMessageId).toBe("message:test-awaited");
    expect(receipt.wait.revision).toBe(1);
    expect(WaitStore.get("wait:test-awaited")?.revision).toBe(1);
  });

  test("a fire-and-forget receipt records nothing — there is no wait to re-key", async () => {
    const withReceipt = createExistingAgentMessaging({
      deliver: () => ({ externalMessageId: "platform:msg-88" }),
      grants: () => grants,
      publish: Bus.publish,
    });

    const receipt = await withReceipt.send(buildSendInput());

    expect(receipt.kind).toBe("sent");
    expect(WaitStore.list()).toHaveLength(0);
  });
});
