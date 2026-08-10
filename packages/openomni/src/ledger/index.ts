import {
  STAKES_EPSILON,
  STAKES_AMOUNT_DENOMINATION,
  STAKES_POLICY_VERSION,
  STAKES_THETA,
  StakesAction,
  StakesAxes,
  StakesCriterionResult,
  StakesValue,
  StakesWindow,
  StakesWindowedLedgerState,
} from "./stakes-contract.js";
import { createStakesWindow } from "./stakes-hash.js";
import { computeStakes, serializeStakes, StakesComputationError } from "./stakes-compute.js";
import { createStakesBroker, StakesBrokerError } from "./stakes-seams.js";
import { assessStakesCriterion } from "./stakes-assessment.js";

export const Stakes = Object.freeze({
  Action: StakesAction,
  Axes: StakesAxes,
  CriterionResult: StakesCriterionResult,
  Value: StakesValue,
  Window: StakesWindow,
  WindowedLedgerState: StakesWindowedLedgerState,
  Theta: STAKES_THETA,
  Epsilon: STAKES_EPSILON,
  PolicyVersion: STAKES_POLICY_VERSION,
  AmountDenomination: STAKES_AMOUNT_DENOMINATION,
  createWindow: createStakesWindow,
  compute: computeStakes,
  serialize: serializeStakes,
  ComputationError: StakesComputationError,
  createBroker: createStakesBroker,
  BrokerError: StakesBrokerError,
  assessCriterion: assessStakesCriterion,
});

export type {
  StakesAction,
  StakesAxes,
  StakesCriterionResult,
  StakesKnownFingerprint,
  StakesValue,
  StakesWindow,
  StakesWindowInput,
  StakesWindowedLedgerState,
} from "./stakes-contract.js";
export type {
  CompletionStakesContext,
  CompletionStakesBinding,
  CompletionStakesInjection,
  CompletionStakesToken,
  StakesAuthorityPort,
  StakesAuthorityRequest,
  StakesAuthoritySnapshot,
  StakesBroker,
  StakesInjectionDenial,
  VoiceStakesContext,
  VoiceStakesBinding,
  VoiceStakesInjection,
  VoiceStakesToken,
  VoiceAuthorizationRequest,
  VoiceAuthorizationSnapshot,
} from "./stakes-seams.js";
export type { StakesCriterionAssessment } from "./stakes-assessment.js";
