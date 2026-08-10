export { findWaitCandidates, type WaitResolution } from "./correlation.js";
export {
  dispatchEvidence,
  ingressEvidence,
  responderCandidates,
  targetsOfPendingInteraction,
  targetsOfWait,
} from "./matcher.js";
export { WaitService } from "./lifecycle.js";
export { requestedWaitAction, type RequestedWaitAction } from "./requested-action.js";
