import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { EgressBudgetStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createExistingAgentMessaging } from "../../../src/router/messaging/send.js";
import { evaluateSocialBudget } from "../../../src/router/messaging/social-budget.js";
import {
  buildGrant,
  buildSendInput,
  messagingNow,
  registerAgentFixture,
} from "../../helpers/messaging.js";
import { resetStores } from "../_router-fixture";

const ZERO_STATE: Gateway.EgressDebitState = {
  countInWindow: 0,
  notifyInWindow: 0,
  converseInWindow: 0,
};

const budget = (overrides: Partial<Gateway.SocialBudget> = {}): Gateway.SocialBudget => ({
  id: "budget:target",
  targetActorId: "actor:target",
  maxPerWindow: 2,
  windowMs: 60_000,
  cooldownMs: 0,
  ...overrides,
});

describe("evaluateSocialBudget (pure fold, #219)", () => {
  test("fail-safe default: no Owner-declared budget suppresses cold proactive at zero", () => {
    expect(
      evaluateSocialBudget(undefined, ZERO_STATE, { class: "notify", at: messagingNow }),
    ).toEqual({ suppress: "budget_exhausted" });
  });

  test("do-not-contact is a hard kill switch, ahead of any count", () => {
    expect(
      evaluateSocialBudget(budget({ doNotContact: true }), ZERO_STATE, {
        class: "notify",
        at: messagingNow,
      }),
    ).toEqual({ suppress: "dnc_denied" });
  });

  test("a lapsed allowance re-applies the fail-safe (suppressed, not admitted)", () => {
    expect(
      evaluateSocialBudget(budget({ expiresAt: messagingNow - 1 }), ZERO_STATE, {
        class: "notify",
        at: messagingNow,
      }),
    ).toEqual({ suppress: "budget_exhausted" });
  });

  test("window cap: at the cap, the next send is budget_exhausted", () => {
    expect(
      evaluateSocialBudget(
        budget({ maxPerWindow: 2 }),
        { ...ZERO_STATE, countInWindow: 2 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toEqual({ suppress: "budget_exhausted" });
    expect(
      evaluateSocialBudget(
        budget({ maxPerWindow: 2 }),
        { ...ZERO_STATE, countInWindow: 1 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toBe("allow");
  });

  test("cooldown: a send within cooldownMs of the last is cooldown_suppressed", () => {
    const b = budget({ cooldownMs: 10_000 });
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, lastSendAt: messagingNow - 5_000 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toEqual({ suppress: "cooldown_suppressed" });
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, lastSendAt: messagingNow - 20_000 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toBe("allow");
  });

  test("class caps bound one class without capping the other", () => {
    const b = budget({ maxPerWindow: 10, classCaps: { notify: 1 } });
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, countInWindow: 1, notifyInWindow: 1 },
        {
          class: "notify",
          at: messagingNow,
        },
      ),
    ).toEqual({ suppress: "budget_exhausted" });
    // converse is uncapped by classCaps.notify.
    expect(
      evaluateSocialBudget(
        b,
        { ...ZERO_STATE, countInWindow: 1, notifyInWindow: 1 },
        {
          class: "converse",
          at: messagingNow,
        },
      ),
    ).toBe("allow");
  });

  test("quiet hours blackout suppresses; same-day and overnight-wrap windows both hold", () => {
    // messagingNow = 5_000_000_000_000 → minute-of-day UTC.
    const minute = Math.floor(messagingNow / 60_000) % 1440;
    const sameDay = budget({
      quietHours: { startMinuteUtc: minute, endMinuteUtc: (minute + 5) % 1440 },
    });
    expect(
      evaluateSocialBudget(sameDay, ZERO_STATE, { class: "notify", at: messagingNow }),
    ).toEqual({ suppress: "cooldown_suppressed" });
    // A window that does not contain `minute` admits.
    const elsewhere = budget({
      quietHours: { startMinuteUtc: (minute + 10) % 1440, endMinuteUtc: (minute + 20) % 1440 },
    });
    expect(evaluateSocialBudget(elsewhere, ZERO_STATE, { class: "notify", at: messagingNow })).toBe(
      "allow",
    );
  });
});

describe("send kernel active-egress gate (#219 seam)", () => {
  let deliveries: string[];
  let grants: Gateway.SenderTargetGrant[];
  let budgets: Gateway.SocialBudget[];

  function messaging(withGate = true) {
    return createExistingAgentMessaging({
      deliver: (message) => {
        deliveries.push(message.messageId);
      },
      grants: () => grants,
      ...(withGate ? { budgets: () => budgets } : {}),
      publish: Bus.publish,
    });
  }

  beforeEach(() => {
    resetStores();
    deliveries = [];
    grants = [buildGrant("grant:sender->target")];
    budgets = [];
    registerAgentFixture("actor:sender");
    registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
  });

  test("backward-compat: with NO budget source injected, a cold proactive send is unaffected", async () => {
    const receipt = await messaging(false).send(buildSendInput());
    expect(receipt.kind).toBe("sent");
    expect(deliveries).toEqual(["message:test"]);
    // The gate never touched the debit ledger.
    expect(EgressBudgetStore.readState("actor:sender", "actor:target", 0).countInWindow).toBe(0);
  });

  test("fail-safe default: gate wired but no budget entry → cold proactive denied budget_exhausted", async () => {
    const receipt = await messaging().send(buildSendInput());
    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("budget_exhausted");
    expect(deliveries).toHaveLength(0);
    expect(EgressBudgetStore.readState("actor:sender", "actor:target", 0).countInWindow).toBe(0);
  });

  test("an admitted send records a debit (record-before-act)", async () => {
    budgets = [budget()];
    const receipt = await messaging().send(buildSendInput());
    expect(receipt.kind).toBe("sent");
    expect(deliveries).toEqual(["message:test"]);
    const state = EgressBudgetStore.readState("actor:sender", "actor:target", 0);
    expect(state.countInWindow).toBe(1);
    expect(state.notifyInWindow).toBe(1);
    expect(state.lastSendAt).toBe(messagingNow);
  });

  test("split-evasion: the cap survives across separate send calls (debit is durable)", async () => {
    budgets = [budget({ maxPerWindow: 1 })];
    const first = await messaging().send(buildSendInput({ messageId: "message:1" }));
    const second = await messaging().send(buildSendInput({ messageId: "message:2" }));
    expect(first.kind).toBe("sent");
    expect(second.kind).toBe("denied");
    if (second.kind !== "denied") throw new Error("expected denial");
    expect(second.code).toBe("budget_exhausted");
    expect(deliveries).toEqual(["message:1"]);
  });

  test("cooldown-block: a second send within cooldownMs is cooldown_suppressed", async () => {
    budgets = [budget({ maxPerWindow: 10, cooldownMs: 30_000 })];
    const first = await messaging().send(
      buildSendInput({ messageId: "message:1", at: messagingNow }),
    );
    const second = await messaging().send(
      buildSendInput({ messageId: "message:2", at: messagingNow + 5_000 }),
    );
    expect(first.kind).toBe("sent");
    expect(second.kind).toBe("denied");
    if (second.kind !== "denied") throw new Error("expected denial");
    expect(second.code).toBe("cooldown_suppressed");
    // A send past the cooldown is admitted again.
    const third = await messaging().send(
      buildSendInput({ messageId: "message:3", at: messagingNow + 40_000 }),
    );
    expect(third.kind).toBe("sent");
    expect(deliveries).toEqual(["message:1", "message:3"]);
  });

  test("DNC-deny: a do-not-contact target is denied dnc_denied with nothing delivered", async () => {
    budgets = [budget({ doNotContact: true })];
    const receipt = await messaging().send(buildSendInput());
    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("dnc_denied");
    expect(deliveries).toHaveLength(0);
  });

  test("reply-not-throttled: a reply-scoped grant bypasses the gate even under do-not-contact", async () => {
    // A reply into the initiating container (surface key qa:target-1), while
    // the target carries a DNC budget: the reply still delivers and records NO
    // debit — the gate only governs cold proactive outreach.
    grants = [
      {
        id: "instance-1",
        senderId: "actor:sender",
        targetActorId: "actor:target",
        operations: ["fire_and_forget", "awaited"],
        expiresAt: messagingNow + 60_000,
        ruleId: "rule-1",
        replyScope: { surfaceKey: "qa:target-1" },
      },
    ];
    budgets = [budget({ doNotContact: true })];
    const receipt = await messaging().send(buildSendInput());
    expect(receipt.kind).toBe("sent");
    expect(deliveries).toEqual(["message:test"]);
    expect(EgressBudgetStore.readState("actor:sender", "actor:target", 0).countInWindow).toBe(0);
  });
});
