import {
  STAKES_AMOUNT_DENOMINATION,
  STAKES_EPSILON,
  STAKES_THETA,
  type StakesValue,
} from "./stakes-contract.js";
import { computeStakes, serializeStakes } from "./stakes-compute.js";
import { hashStakesValue } from "./stakes-digest.js";
import {
  createDriverBroker,
  driverAction,
  driverBoundaryAction,
  driverCompletionBinding,
  driverDigest,
  driverState,
  driverVoiceBinding,
} from "./stakes-driver-fixture.js";
import type { CompletionStakesInjection, VoiceStakesInjection } from "./stakes-seams.js";

export type StakesDriverScenario = "threshold-and-split" | "forged-local-value";

export function runStakesScenario(
  scenario: StakesDriverScenario,
): Readonly<Record<string, unknown>> {
  switch (scenario) {
    case "threshold-and-split":
      return thresholdAndSplitScenario();
    case "forged-local-value":
      return forgedLocalValueScenario();
  }
}

function thresholdAndSplitScenario(): Readonly<Record<string, unknown>> {
  const minus = boundaryRun("minus", 49_000_000);
  const equal = boundaryRun("equal", 50_000_000);
  const plus = boundaryRun("plus", 51_000_000);
  const first = driverAction("split:1", {
    irreversibleChangeCount: 1,
    externalSurfaceCount: 1,
    spendMicros: 400_000,
    budgetReservedMicros: 200_000,
    outreachRecipientCount: 1,
    contentFingerprints: [driverDigest("split:a")],
  });
  const second = driverAction("split:2", {
    irreversibleChangeCount: 1,
    externalSurfaceCount: 0,
    spendMicros: 600_000,
    budgetReservedMicros: 800_000,
    outreachRecipientCount: 1,
    contentFingerprints: [driverDigest("split:b")],
  });
  const composed = driverAction("composed", {
    irreversibleChangeCount: 2,
    externalSurfaceCount: 1,
    spendMicros: 1_000_000,
    budgetReservedMicros: 1_000_000,
    outreachRecipientCount: 2,
    contentFingerprints: [driverDigest("split:a"), driverDigest("split:b")],
  });
  const split = computeStakes(second, driverState([first]));
  const whole = computeStakes(composed, driverState([]));
  const broker = createDriverBroker(equal.action, equal.ledgerState);
  const completionBinding = driverCompletionBinding("equal");
  const voiceBinding = driverVoiceBinding("equal");
  const completionToken = broker.issuer.issueCompletion(completionBinding);
  const voiceToken = broker.issuer.issueVoice(voiceBinding);
  const completion = broker.completion.inject(completionToken, completionBinding);
  const voice = broker.voice.inject(voiceToken, voiceBinding);
  const completionReference = completion.ok ? completion.context.stakes.reference : null;
  const voiceReference = voice.ok ? voice.context.stakes.reference : null;
  const archivedInputDigest = hashStakesValue([
    "stakes-driver-threshold-and-split-v1",
    minus.computed.inputDigest,
    equal.computed.inputDigest,
    plus.computed.inputDigest,
    split.inputDigest,
    whole.inputDigest,
  ]);
  return {
    version: "stakes-driver-v1",
    mode: "scenario",
    scenario: "threshold-and-split",
    ok:
      minus.replayEqual &&
      equal.replayEqual &&
      plus.replayEqual &&
      serializeStakes(split) !== serializeStakes(whole) &&
      sameAxes(split, whole) &&
      split.value === whole.value &&
      completionReference === equal.computed.reference &&
      voiceReference === equal.computed.reference,
    resultCode: "threshold_and_split_verified",
    archivedInputDigest,
    amountDenomination: STAKES_AMOUNT_DENOMINATION,
    theta: STAKES_THETA,
    epsilon: STAKES_EPSILON,
    boundaries: {
      minus: minus.receipt,
      equal: equal.receipt,
      plus: plus.receipt,
    },
    split: {
      axesEqual: sameAxes(split, whole),
      valueEqual: split.value === whole.value,
      comparisonEqual: split.comparison === whole.comparison,
    },
    seams: {
      kernelReference: equal.computed.reference,
      completionReference,
      voiceReference,
    },
  };
}

function forgedLocalValueScenario(): Readonly<Record<string, unknown>> {
  const action = driverBoundaryAction("trusted", 50_000_000);
  const ledgerState = driverState([]);
  const kernelValue = computeStakes(action, ledgerState);
  const kernelReferenceBefore = kernelValue.reference;
  const forged: unknown = JSON.parse(serializeStakes(kernelValue));
  const locallyRecomputed = computeStakes(action, ledgerState);
  const broker = createDriverBroker(action, ledgerState);
  const foreignBroker = createDriverBroker(action, ledgerState);
  const completionBinding = driverCompletionBinding("trusted");
  const voiceBinding = driverVoiceBinding("trusted");
  const completionToken = broker.issuer.issueCompletion(completionBinding);
  const voiceToken = broker.issuer.issueVoice(voiceBinding);
  const foreignToken = foreignBroker.issuer.issueCompletion(completionBinding);
  const originalCompletionBefore = broker.completion.inject(completionToken, completionBinding);
  const originalVoiceBefore = broker.voice.inject(voiceToken, voiceBinding);
  const forgedCompletion = broker.completion.inject(forged, completionBinding);
  const forgedVoice = broker.voice.inject(forged, voiceBinding);
  const localCompletion = broker.completion.inject(locallyRecomputed, completionBinding);
  const localVoice = broker.voice.inject(locallyRecomputed, voiceBinding);
  const foreignCompletion = broker.completion.inject(foreignToken, completionBinding);
  const originalCompletionAfter = broker.completion.inject(completionToken, completionBinding);
  const originalVoiceAfter = broker.voice.inject(voiceToken, voiceBinding);
  const kernelReferenceAfter = kernelValue.reference;
  const completionReferenceBefore = injectedReference(originalCompletionBefore);
  const completionReferenceAfter = injectedReference(originalCompletionAfter);
  const voiceReferenceBefore = injectedReference(originalVoiceBefore);
  const voiceReferenceAfter = injectedReference(originalVoiceAfter);
  return {
    version: "stakes-driver-v1",
    mode: "scenario",
    scenario: "forged-local-value",
    ok:
      !forgedCompletion.ok &&
      !forgedVoice.ok &&
      !localCompletion.ok &&
      !localVoice.ok &&
      !foreignCompletion.ok &&
      kernelReferenceBefore === kernelReferenceAfter &&
      completionReferenceBefore === kernelReferenceBefore &&
      completionReferenceAfter === kernelReferenceBefore &&
      voiceReferenceBefore === kernelReferenceBefore &&
      voiceReferenceAfter === kernelReferenceBefore,
    resultCode: "forged_local_value_denied",
    archivedInputDigest: kernelValue.inputDigest,
    amountDenomination: STAKES_AMOUNT_DENOMINATION,
    completionDenial: forgedCompletion.ok ? null : forgedCompletion.denial,
    voiceDenial: forgedVoice.ok ? null : forgedVoice.denial,
    forgedValueReachedCompletion: forgedCompletion.ok,
    forgedValueReachedVoice: forgedVoice.ok,
    localRecomputeReachedCompletion: localCompletion.ok,
    localRecomputeReachedVoice: localVoice.ok,
    foreignBrokerTokenReachedCompletion: foreignCompletion.ok,
    kernelReferenceBefore,
    kernelReferenceAfter,
    originalCompletionReferenceBefore: completionReferenceBefore,
    originalCompletionReferenceAfter: completionReferenceAfter,
    originalVoiceReferenceBefore: voiceReferenceBefore,
    originalVoiceReferenceAfter: voiceReferenceAfter,
  };
}

function boundaryRun(label: string, spendMicros: number) {
  const action = driverBoundaryAction(label, spendMicros);
  const ledgerState = driverState([]);
  const first = computeStakes(action, ledgerState);
  const second = computeStakes(action, ledgerState);
  return {
    computed: first,
    action,
    ledgerState,
    receipt: {
      value: first.value,
      comparison: first.comparison,
      reference: first.reference,
      inputDigest: first.inputDigest,
      replayCount: 2,
      replayEqual: serializeStakes(first) === serializeStakes(second),
    },
    replayEqual: serializeStakes(first) === serializeStakes(second),
  };
}

function sameAxes(left: StakesValue, right: StakesValue): boolean {
  return JSON.stringify(left.axes) === JSON.stringify(right.axes);
}

function injectedReference(
  injection: CompletionStakesInjection | VoiceStakesInjection,
): string | null {
  return injection.ok ? injection.context.stakes.reference : null;
}
