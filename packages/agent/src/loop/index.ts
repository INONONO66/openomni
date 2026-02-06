// Loop module - Phase 2 implementation
// Event routing, dispatching, and concurrency control

export {
  EventEnvelope,
  NormalizedEvent,
  ValidationError,
  normalize,
  Envelope,
} from "./envelope";

export { Router, RouterRule } from "./router";

export { Dispatcher } from "./dispatcher";

export { ConcurrencyConfig, ConcurrencyGate } from "./concurrency";
