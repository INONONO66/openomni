import type { StakesAction } from "./stakes-contract.js";
import { hashStakesValue } from "./stakes-digest.js";
import { createStakesWindow } from "./stakes-hash.js";
import { createStakesBroker } from "./stakes-seams.js";

const driverWindow = createStakesWindow({
  ownerKey: "owner:469",
  windowId: "window:driver",
  openedAt: 10_000,
  closesAt: 20_000,
});

export function driverBoundaryAction(actionId: string, spendMicros: number): StakesAction {
  return driverAction(actionId, {
    irreversibleChangeCount: 2,
    externalSurfaceCount: 0,
    spendMicros,
    budgetReservedMicros: 0,
    outreachRecipientCount: 1,
    contentFingerprints: [driverDigest("boundary")],
  });
}

export function driverAction(actionId: string, facts: StakesAction["facts"]): StakesAction {
  return {
    actionId,
    ownerKey: driverWindow.ownerKey,
    windowRef: driverWindow.windowRef,
    ledgerObservedAt: 15_000,
    facts,
  };
}

export function driverState(actions: readonly StakesAction[]) {
  return { window: driverWindow, actions, knownFingerprints: [] };
}

export function driverDigest(seed: string): string {
  return hashStakesValue(["stakes-driver-fixture-v1", seed]);
}

export function driverCompletionBinding(actionRef: string) {
  return {
    surface: "work.complete.pre" as const,
    ownerKey: driverWindow.ownerKey,
    workItemHash: "wi_driver_469",
    requestId: "request_driver_469",
    contractRevision: "1",
    basisRef: driverDigest("basis"),
    expectedHead: 2,
    actionRef,
    windowRef: driverWindow.windowRef,
    asOfOwnerSeq: 469,
    calculatorVersion: "stakes-policy-v1" as const,
    ledgerRangeDigest: driverDigest("ledger-range"),
    noveltyBasisDigest: driverDigest("novelty-basis"),
  };
}

export function driverVoiceBinding(actionRef: string) {
  return {
    surface: "authorized_voice" as const,
    ownerKey: driverWindow.ownerKey,
    evaluationId: "jester_driver_469",
    authorizationReceiptRef: driverDigest("voice-authorization"),
    basisRef: driverDigest("basis"),
    actionRef,
    windowRef: driverWindow.windowRef,
    asOfOwnerSeq: 469,
    calculatorVersion: "stakes-policy-v1" as const,
    ledgerRangeDigest: driverDigest("ledger-range"),
    noveltyBasisDigest: driverDigest("novelty-basis"),
  };
}

export function createDriverBroker(action: StakesAction, state: ReturnType<typeof driverState>) {
  const authorizedVoice = driverVoiceBinding(action.actionId);
  return createStakesBroker({
    read(request) {
      return {
        action,
        state,
        basisRef: request.basisRef,
        asOfOwnerSeq: request.asOfOwnerSeq,
        ledgerRangeDigest: request.ledgerRangeDigest,
        noveltyBasisDigest: request.noveltyBasisDigest,
      };
    },
    readVoiceAuthorization() {
      return {
        ownerKey: authorizedVoice.ownerKey,
        evaluationId: authorizedVoice.evaluationId,
        authorizationReceiptRef: authorizedVoice.authorizationReceiptRef,
        actionRef: authorizedVoice.actionRef,
        windowRef: authorizedVoice.windowRef,
        asOfOwnerSeq: authorizedVoice.asOfOwnerSeq,
      };
    },
  });
}
