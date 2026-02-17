// Dispatch domain — event envelope creation, routing, and task dispatch

export {
  type EventEnvelope,
  type NormalizedEvent,
  type EventTrust,
  type EventPriority,
  type EventSource,
  ValidationError,
  normalize,
  Envelope,
} from "./envelope";

export { Router, type RouterRule, type RoutingDecision } from "./router";

export { Dispatcher } from "./dispatcher";
