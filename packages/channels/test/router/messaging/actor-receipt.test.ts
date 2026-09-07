import { afterEach, beforeEach, expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { createExistingAgentMessaging } from "../../../src/router/messaging/send";
import { buildGrant, buildSendInput, registerAgentFixture } from "../../helpers/messaging";
import { resetStores } from "../_router-fixture";

beforeEach(() => {
  resetStores();
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});
afterEach(() => Storage.reset());

for (const value of ["accepted", "rejected", "unknown"] as const) {
  test(`actor transport preserves the ${value} receipt under a stable idempotency key`, async () => {
    // Given a real send kernel and a transport with an explicit receipt.
    const keys: string[] = [];
    const messaging = createExistingAgentMessaging({
      grants: () => [buildGrant("grant:sender->target")],
      publish: () => undefined,
      deliver: async (message) => {
        keys.push(message.idempotencyKey);
        return { value };
      },
    });
    const input = buildSendInput();
    // When the same delivery is retried.
    const receipts = await Promise.all([messaging.send(input), messaging.send(input)]);
    // Then actor classification is preserved, not collapsed to success/failure.
    expect(keys).toEqual([input.messageId, input.messageId]);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ kind: "sent", delivery: value });
    }
  });
}
