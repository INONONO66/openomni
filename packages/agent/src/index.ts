// Agent package public API (#1247): exactly seven namespaces.
export * as Kernel from "./kernel";
export * as Session from "./session";
export * as Bundle from "./kernel/bundle";
export * as Journal from "./store";
export * as Model from "./model";
export * as Inspect from "./inspect";
export * as Testing from "./testing";

// ─── S8 perimeter: named exports consumed by packages/channels (legal
// channels -> agent band edges), pinned shrink-only by script/check-deps.ts.
// Do not grow this list; retiring it is a separate decision, owned by no lane.
export { decisionFromEvaluation, evaluatePermission } from "./kernel/gate/match";
export type { PolicyEvaluationInput } from "./kernel/gate/compile";
export { requireSubAdapter, withStoreTimestamps } from "./store/storage/timestamped-store";
export { createDecisionFactPort } from "./store/decision";
export { createSurfaceKeyStore } from "./store/surface-key";
export { StoredEndpoint, StoredIdentity } from "./store/storage/actor-schema";
