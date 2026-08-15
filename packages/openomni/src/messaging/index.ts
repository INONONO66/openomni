// Existing-agent messaging (#215): the delivery-created public surface,
// exported as the `@openomni/openomni/messaging` subpath.
export { SendInput, SenderTargetGrant } from "./schema.js";
export { createExistingAgentMessaging } from "./send.js";
export type { DeliveryReceipt, ExistingAgentMessaging, OutboundMessage } from "./send.js";
