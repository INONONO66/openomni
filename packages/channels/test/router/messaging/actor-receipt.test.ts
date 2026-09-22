import { Effect } from "effect";
import { channelRequests } from "../../helpers/channel-requests";
import { channelTransaction } from "../../helpers/channel-transaction";
import { runEffect } from "../../helpers/effect";
import { seededRequests } from "../../helpers/requests";
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
      requests: channelRequests(seededRequests()),
      transaction: channelTransaction,
      grants: () => [buildGrant("grant:sender->target")],
      publish: () => undefined,
      deliver: async (message: Parameters<Parameters<typeof createExistingAgentMessaging>[0]["deliver"]>[0]) => {
        keys.push(message.idempotencyKey);
        return { value };
      },
    });
    const input = buildSendInput();
    // When the same delivery is retried.
    const receipts = await runEffect(Effect.all([messaging.send(input), messaging.send(input)], { concurrency: 2 }));
    // Then actor classification is preserved, not collapsed to success/failure.
    expect(keys).toEqual([input.messageId, input.messageId]);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ kind: "sent", delivery: value });
    }
  });
}
