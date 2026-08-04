import {
  STAKES_POLICY_VERSION,
  STAKES_THETA,
  createStakesSchemas,
  type StakesAction,
  type StakesAxes,
  type StakesKnownFingerprint,
  type StakesValue as StakesValueType,
} from "./stakes-contract.js";
import { compareStakesValue, hashStakesValue, stakesWindowRef } from "./stakes-hash.js";
import { expectedStakesReference } from "./stakes-reference.js";

const IRREVERSIBILITY_WEIGHT = 400;
const EXTERNAL_SURFACE_WEIGHT = 250;
const OUTREACH_WEIGHT = 100;
const NOVELTY_WEIGHT = 50;
const MICROS_PER_POINT = 1_000_000;
const InternalSchemas = createStakesSchemas();

export class StakesComputationError extends Error {
  readonly name = "StakesComputationError";

  constructor(
    readonly code: "candidate_outside_window" | "duplicate_action",
    readonly actionId: string,
  ) {
    super(`${code}: ${actionId}`);
  }
}

export function computeStakes(actionInput: unknown, stateInput: unknown): StakesValueType {
  const action = InternalSchemas.StakesAction.parse(actionInput);
  const state = InternalSchemas.StakesWindowedLedgerState.parse(stateInput);
  assertCandidateInWindow(action, state.window);
  assertUniqueCandidate(action.actionId, [...state.actions, action]);
  const actions = [
    ...state.actions.filter(
      (recorded) =>
        recorded.ownerKey === state.window.ownerKey &&
        recorded.windowRef === state.window.windowRef &&
        recorded.ledgerObservedAt >= state.window.openedAt &&
        recorded.ledgerObservedAt < state.window.closesAt,
    ),
    action,
  ].sort((left, right) => compareIdentifiers(left.actionId, right.actionId));
  const knownFingerprints = state.knownFingerprints
    .filter(
      (known) =>
        known.ownerKey === state.window.ownerKey && known.firstObservedAt < state.window.openedAt,
    )
    .sort(
      (left, right) =>
        compareIdentifiers(left.fingerprint, right.fingerprint) ||
        left.firstObservedAt - right.firstObservedAt,
    );
  const axes = InternalSchemas.StakesAxes.parse(calculateAxes(actions, knownFingerprints));
  const value = Object.values(axes).reduce((total, axis) => total + axis, 0);
  const comparison = compareStakesValue(value);
  const windowRef = stakesWindowRef(state.window);
  const inputDigest = hashInputs(state.window, actions, knownFingerprints);
  const includedActionIds = actions.map((recorded) => recorded.actionId);
  const reference = expectedStakesReference({
    policyVersion: STAKES_POLICY_VERSION,
    inputDigest,
    windowRef,
    axes,
    value,
    theta: STAKES_THETA,
    comparison,
    includedActionIds,
  });
  return InternalSchemas.StakesValue.parse({
    version: "stakes-v1",
    policyVersion: STAKES_POLICY_VERSION,
    reference,
    inputDigest,
    windowRef,
    window: state.window,
    axes,
    value,
    theta: STAKES_THETA,
    comparison,
    includedActionIds,
  });
}

export function serializeStakes(value: StakesValueType): string {
  return JSON.stringify(InternalSchemas.StakesValue.parse(value));
}

function calculateAxes(
  actions: readonly StakesAction[],
  knownFingerprints: readonly StakesKnownFingerprint[],
): StakesAxes {
  let irreversibleChangeCount = 0;
  let externalSurfaceCount = 0;
  let spendMicros = 0;
  let budgetReservedMicros = 0;
  let outreachRecipientCount = 0;
  const seenFingerprints = new Set(knownFingerprints.map((known) => known.fingerprint));
  let novelFingerprintCount = 0;
  for (const action of actions) {
    irreversibleChangeCount += action.facts.irreversibleChangeCount;
    externalSurfaceCount += action.facts.externalSurfaceCount;
    spendMicros += action.facts.spendMicros;
    budgetReservedMicros += action.facts.budgetReservedMicros;
    outreachRecipientCount += action.facts.outreachRecipientCount;
    for (const fingerprint of action.facts.contentFingerprints) {
      if (!seenFingerprints.has(fingerprint)) {
        seenFingerprints.add(fingerprint);
        novelFingerprintCount += 1;
      }
    }
  }
  return {
    irreversibility: irreversibleChangeCount * IRREVERSIBILITY_WEIGHT,
    externalSurface: externalSurfaceCount * EXTERNAL_SURFACE_WEIGHT,
    spend: Math.floor(spendMicros / MICROS_PER_POINT),
    budget: Math.floor(budgetReservedMicros / MICROS_PER_POINT),
    outreach: outreachRecipientCount * OUTREACH_WEIGHT,
    novelty: novelFingerprintCount * NOVELTY_WEIGHT,
  };
}

function hashInputs(
  window: StakesValueType["window"],
  actions: readonly StakesAction[],
  knownFingerprints: readonly StakesKnownFingerprint[],
): string {
  return hashStakesValue([
    "stakes-input-v1",
    STAKES_POLICY_VERSION,
    [window.ownerKey, window.windowId, window.openedAt, window.closesAt],
    actions.map((action) => [
      action.actionId,
      action.ownerKey,
      action.windowRef,
      action.ledgerObservedAt,
      action.facts.irreversibleChangeCount,
      action.facts.externalSurfaceCount,
      action.facts.spendMicros,
      action.facts.budgetReservedMicros,
      action.facts.outreachRecipientCount,
      [...action.facts.contentFingerprints].sort(compareIdentifiers),
    ]),
    knownFingerprints.map((known) => [known.ownerKey, known.fingerprint, known.firstObservedAt]),
  ]);
}

function assertCandidateInWindow(action: StakesAction, window: StakesValueType["window"]): void {
  if (
    action.ownerKey !== window.ownerKey ||
    action.windowRef !== window.windowRef ||
    action.ledgerObservedAt < window.openedAt ||
    action.ledgerObservedAt >= window.closesAt
  ) {
    throw new StakesComputationError("candidate_outside_window", action.actionId);
  }
}

function assertUniqueCandidate(actionId: string, actions: readonly StakesAction[]): void {
  if (actions.filter((action) => action.actionId === actionId).length > 1) {
    throw new StakesComputationError("duplicate_action", actionId);
  }
}

function compareIdentifiers(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
