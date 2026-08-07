// Existing-agent messaging (#215): the delivery-created public surface,
// exported as the `@openomni/openomni/messaging` subpath.
export { Events as MessagingEvents } from "./events.js";
export {
  ExistingAgentMessageDriverScenarios,
  ExistingAgentMessageDriverVersion,
  runExistingAgentMessageDriver,
} from "./existing-agent-message-driver.js";
export type {
  ExistingAgentMessageDriverExecution,
  ExistingAgentMessageDriverScenario,
} from "./existing-agent-message-driver.js";
export {
  AwaitSpec,
  MessageDenialCode,
  MessageOperation,
  MessageTarget,
  SendInput,
  SenderTargetGrant,
  resolveSenderTargetGrant,
} from "./schema.js";
export type { DeliveryTarget, SendReceipt } from "./schema.js";
export { createExistingAgentMessaging } from "./send.js";
export type { ExistingAgentMessaging, MessagingPorts, OutboundMessage } from "./send.js";
