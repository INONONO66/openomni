import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { ActorRegistry } from "@openomni/ledger";
import { Bus } from "../../helpers/observation";
import {
  deliverySurfaceKey,
  hasScopedSenderTargetCandidate,
  resolveScopedSenderTargetGrant,
} from "../../../src/router/messaging/grant.js";
import { createExistingAgentMessaging } from "../../../src/router/messaging/send.js";
import { buildSendInput, messagingNow, registerAgentFixture } from "../../helpers/messaging.js";
import { resetStores } from "../_router-fixture";

/**
 * #708 scope-aware grant arm: a rule-materialized (reply-scoped) instance is
 * honored exactly inside the container it was created for — evaluated against
 * the surface key derived from the RESOLVED delivery endpoint — and refused
 * everywhere else. The scope-less base evaluator keeps failing closed on
 * these instances (reply-scope-guard.test.ts pins that half).
 */

const scopedInstance = (overrides: Partial<Gateway.SenderTargetGrant> = {}) =>
  ({
    id: "instance-1",
    senderId: "actor:sender",
    targetActorId: "actor:target",
    operations: ["fire_and_forget", "awaited"],
    expiresAt: messagingNow + 60_000,
    ruleId: "rule-1",
    replyScope: { surfaceKey: "qa:target-1" },
    ...overrides,
  }) as Gateway.SenderTargetGrant;

const claim = {
  senderId: "actor:sender",
  targetActorId: "actor:target",
  operation: "fire_and_forget",
  at: messagingNow,
} as const;

describe("scope-aware grant evaluation (pure)", () => {
  test("deliverySurfaceKey derives channel:externalId — the facts both sides share", () => {
    expect(deliverySurfaceKey({ channel: "qa", externalId: "target-1" })).toBe("qa:target-1");
  });

  test("a scoped instance resolves only for its own surface key", () => {
    const grants = [scopedInstance()];
    expect(
      resolveScopedSenderTargetGrant(grants, { ...claim, surfaceKey: "qa:target-1" })?.id,
    ).toBe("instance-1");
    expect(
      resolveScopedSenderTargetGrant(grants, { ...claim, surfaceKey: "discord:target-9" }),
    ).toBeUndefined();
  });

  test("a scope-less standing grant is never resolved by the scoped arm", () => {
    const standing = scopedInstance({
      id: "standing-1",
      ruleId: undefined,
      replyScope: undefined,
      expiresAt: undefined,
    });
    expect(
      resolveScopedSenderTargetGrant([standing], { ...claim, surfaceKey: "qa:target-1" }),
    ).toBeUndefined();
  });

  test("expiry and operation bounds hold on the scoped arm too", () => {
    const expired = scopedInstance({ expiresAt: messagingNow - 1 });
    const awaitedOnly = scopedInstance({ id: "instance-2", operations: ["awaited"] });
    expect(
      resolveScopedSenderTargetGrant([expired], { ...claim, surfaceKey: "qa:target-1" }),
    ).toBeUndefined();
    expect(
      resolveScopedSenderTargetGrant([awaitedOnly], { ...claim, surfaceKey: "qa:target-1" }),
    ).toBeUndefined();
  });

  test("candidate check matches scope-carrying instances only, scope unchecked", () => {
    expect(hasScopedSenderTargetCandidate([scopedInstance()], claim)).toBe(true);
    expect(
      hasScopedSenderTargetCandidate(
        [scopedInstance({ replyScope: undefined, ruleId: undefined, expiresAt: undefined })],
        claim,
      ),
    ).toBe(false);
    expect(
      hasScopedSenderTargetCandidate([scopedInstance({ expiresAt: messagingNow - 1 })], claim),
    ).toBe(false);
  });
});

describe("send kernel over reply-scoped instances", () => {
  let grants: Gateway.SenderTargetGrant[];
  let delivered: string[];

  function messaging() {
    return createExistingAgentMessaging({
      deliver: (message) => {
        delivered.push(message.target.endpointId);
        return { value: "accepted" as const };
      },
      grants: () => grants,
      publish: Bus.publish,
    });
  }

  beforeEach(() => {
    resetStores();
    delivered = [];
    grants = [scopedInstance()];
    registerAgentFixture("actor:sender");
    // channel "qa", externalId "target-1" → surface key "qa:target-1".
    registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
  });

  test("a send into the initiating container is granted by the scoped instance", async () => {
    const receipt = await messaging().send(buildSendInput());

    expect(receipt.kind).toBe("sent");
    if (receipt.kind !== "sent") throw new Error("expected sent");
    expect(receipt.grantId).toBe("instance-1");
    expect(delivered).toEqual(["endpoint:target"]);
  });

  test("cross-surface use of the instance is refused ungranted — containment is pinned", async () => {
    ActorRegistry.registerEndpoint({
      id: "endpoint:target-discord",
      actorId: "actor:target",
      channel: "discord",
      externalId: "target-9",
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });

    const receipt = await messaging().send(
      buildSendInput({
        target: { actorId: "actor:target", endpointId: "endpoint:target-discord" },
      }),
    );

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
    expect(receipt.reason).toContain("replies stay inside the initiating container");
    expect(delivered).toHaveLength(0);
  });

  test("with only a scoped candidate, an unresolvable target still yields its typed target denial", async () => {
    grants = [scopedInstance({ targetActorId: "actor:ghost" })];

    const receipt = await messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } }));

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("target_missing");
  });

  test("no candidate at all keeps the ungranted denial ahead of any registry lookup", async () => {
    grants = [];

    const receipt = await messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } }));

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
  });
});
