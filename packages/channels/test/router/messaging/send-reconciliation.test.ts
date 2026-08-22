import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Gateway } from "@openomni/protocol";
import { EgressBudgetStore, Storage, WaitStore } from "@openomni/ledger";
import {
  createExistingAgentMessaging,
  type DeliveryReceipt,
  type OutboundMessage,
} from "../../../src/router/messaging/send.js";
import {
  buildAwaitedSendInput,
  buildGrant,
  buildSendInput,
  registerAgentFixture,
} from "../../helpers/messaging.js";

const activeBudget: Gateway.SocialBudget = {
  id: "budget:reconciliation",
  targetActorId: "actor:target",
  maxPerWindow: 10,
  windowMs: 60_000,
  cooldownMs: 0,
};

type FaultPoint = "after_debit" | "after_wait" | "after_effect" | "after_receipt_cas";

type Probe = Readonly<{
  receipts: readonly Gateway.SendReceipt[];
  effects: number;
  attempts: number;
  debits: number;
  wait: ReturnType<typeof WaitStore.get>;
}>;

async function probe(point: FaultPoint): Promise<Probe> {
  const external = new Map<string, DeliveryReceipt>();
  let attempts = 0;
  let failBeforeEffect = point === "after_debit" || point === "after_wait";
  let failAfterEffect = point === "after_effect";
  let failAfterReceipt = point === "after_receipt_cas";

  const messaging = createExistingAgentMessaging({
    deliver: (message: OutboundMessage) => {
      attempts += 1;
      if (failBeforeEffect) {
        failBeforeEffect = false;
        throw new Error(`fault:${point}`);
      }
      const recorded = external.get(message.messageId);
      if (recorded !== undefined) return recorded;
      const receipt = { externalMessageId: `platform:${message.messageId}` };
      external.set(message.messageId, receipt);
      if (failAfterEffect) {
        failAfterEffect = false;
        throw new Error(`fault:${point}`);
      }
      return receipt;
    },
    grants: () => [buildGrant("grant:reconciliation")],
    budgets: () => [activeBudget],
    publish: (event) => {
      if (event.name === "messaging.sent" && failAfterReceipt) {
        failAfterReceipt = false;
        throw new Error(`fault:${point}`);
      }
    },
  });

  const input =
    point === "after_debit"
      ? buildSendInput({ messageId: `message:${point}` })
      : buildAwaitedSendInput({
          messageId: `message:${point}`,
          waitSpec: (() => {
            const spec = buildAwaitedSendInput().waitSpec;
            if (spec === undefined) throw new Error("awaited fixture requires waitSpec");
            return { ...spec, waitId: `wait:${point}` };
          })(),
        });

  let injected: unknown;
  try {
    await messaging.send(input);
  } catch (error) {
    injected = error;
  }
  expect(injected).toBeInstanceOf(Error);
  expect((injected as Error).message).toBe(`fault:${point}`);
  const resumed = await messaging.send(input);

  return {
    receipts: [resumed],
    effects: external.size,
    attempts,
    debits: EgressBudgetStore.readState("actor:sender", "actor:target", 0).countInWindow,
    wait: input.waitSpec === undefined ? undefined : WaitStore.get(input.waitSpec.waitId),
  };
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});

afterEach(() => Storage.reset());

describe("gateway send crash reconciliation transition table", () => {
  test.each([
    ["after_debit", 2],
    ["after_wait", 2],
    ["after_effect", 2],
    ["after_receipt_cas", 1],
  ] as const)("%s resumes with one debit and one external effect", async (point, attempts) => {
    const result = await probe(point);

    expect(result.receipts[0]?.kind).toBe("sent");
    expect(result.effects).toBe(1);
    expect(result.attempts).toBe(attempts);
    expect(result.debits).toBe(1);
    if (point !== "after_debit") {
      expect(result.wait?.status).toBe("open");
      expect(result.wait?.correlation.replyToMessageId).toBe(`platform:message:${point}`);
    }
  });
});
