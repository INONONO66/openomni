// Session namespace surface (#1247): entity, admission, requests, run, bus.
export {
  adoptSessionAuthority, makeSessionGenerations, createSessionChatRunner, closeSessions, getSessionHandle,
  type GenerationBundle, type SessionHandle, type SessionRunner, type SessionRuntime,
  type SessionCreateOptions, type SessionRunnerInput, type SessionRunnerResult,
  type SessionEntityPorts, type SessionEntityTimerContext, type SessionEntityTurnInput,
  type SessionSystem, type ResolvedSessionRuntime,
} from "./run";
export { decideSessionAdmission, requestAuthorityKernel, commitSessionRequest } from "./mailbox";
export { createSessionRequests, decideRequestTransition, requestBindingDigest } from "./request";
export { receivedMessageAction } from "./commit";
export { SessionEntity, SessionEntityContext, SessionEntityLive, createSessionEntityRunTurn, type SessionKernel } from "./entity";
export { deadlineDelivery, retryDelivery, watchFiredDelivery, watchTimeoutDelivery, type AlarmChainReads } from "./alarm";
export { createObservationBus, scopeObservation } from "./bus";
