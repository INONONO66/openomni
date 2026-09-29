import { ledger } from "../../helpers/ledger";
import { channelRequests } from "../../helpers/channel-requests";
import { channelTransaction } from "../../helpers/channel-transaction";
import { seededRequests } from "../../helpers/requests";
import { Bus } from "../../helpers/observation";
import { registerAgentFixture } from "../../helpers/messaging";

export function sendPorts() {
  return {
    requests: channelRequests(seededRequests()),
    stores: ledger().stores,
    transaction: channelTransaction,
    publish: Bus.publish,
  };
}

export function registerSenderAndTarget(): void {
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
}
