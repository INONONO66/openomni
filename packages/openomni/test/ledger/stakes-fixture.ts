import { createHash } from "node:crypto";
import {
  Stakes,
  type CompletionStakesBinding,
  type StakesAction,
  type VoiceStakesBinding,
} from "@openomni/openomni/ledger";

export const stakesWindow = Stakes.createWindow({
  ownerKey: "owner:469",
  windowId: "window:primary",
  openedAt: 1_000,
  closesAt: 2_000,
});

export function boundaryAction(actionId: string, spendMicros: number): StakesAction {
  return stakesAction(actionId, stakesWindow.windowRef, "owner:469", {
    irreversibleChangeCount: 2,
    externalSurfaceCount: 0,
    spendMicros,
    budgetReservedMicros: 0,
    outreachRecipientCount: 1,
    contentFingerprints: [stakesDigest("boundary")],
  });
}

export function stakesAction(
  actionId: string,
  windowRef: string,
  ownerKey: string,
  facts: StakesAction["facts"],
): StakesAction {
  return { actionId, ownerKey, windowRef, ledgerObservedAt: 1_500, facts };
}

export function zeroFacts(contentFingerprint: string): StakesAction["facts"] {
  return {
    irreversibleChangeCount: 0,
    externalSurfaceCount: 0,
    spendMicros: 0,
    budgetReservedMicros: 0,
    outreachRecipientCount: 0,
    contentFingerprints: [contentFingerprint],
  };
}

export function highFacts(contentFingerprint: string): StakesAction["facts"] {
  return {
    irreversibleChangeCount: 10,
    externalSurfaceCount: 10,
    spendMicros: 100_000_000,
    budgetReservedMicros: 100_000_000,
    outreachRecipientCount: 10,
    contentFingerprints: [contentFingerprint],
  };
}

export function knownFingerprint(ownerKey: string, fingerprint: string) {
  return { ownerKey, fingerprint, firstObservedAt: 0 };
}

export function stakesDigest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

export function completionBinding(actionRef: string): CompletionStakesBinding {
  return {
    surface: "work.complete.pre" as const,
    ownerKey: stakesWindow.ownerKey,
    workItemHash: "wi_469",
    requestId: "request_469",
    contractRevision: "1",
    basisRef: stakesDigest("basis"),
    expectedHead: 2,
    actionRef,
    windowRef: stakesWindow.windowRef,
    asOfOwnerSeq: 469,
    calculatorVersion: Stakes.PolicyVersion,
    ledgerRangeDigest: stakesDigest("ledger-range"),
    noveltyBasisDigest: stakesDigest("novelty-basis"),
  };
}

export function voiceBinding(actionRef: string): VoiceStakesBinding {
  return {
    surface: "authorized_voice" as const,
    ownerKey: stakesWindow.ownerKey,
    evaluationId: "jester:469",
    authorizationReceiptRef: stakesDigest("voice-authorization"),
    basisRef: stakesDigest("basis"),
    actionRef,
    windowRef: stakesWindow.windowRef,
    asOfOwnerSeq: 469,
    calculatorVersion: Stakes.PolicyVersion,
    ledgerRangeDigest: stakesDigest("ledger-range"),
    noveltyBasisDigest: stakesDigest("novelty-basis"),
  };
}

export function captureComputationError(run: () => unknown): {
  readonly code: InstanceType<typeof Stakes.ComputationError>["code"];
  readonly actionId: string;
} {
  try {
    run();
  } catch (error) {
    if (error instanceof Stakes.ComputationError) {
      return { code: error.code, actionId: error.actionId };
    }
    throw error;
  }
  throw new Error("expected Stakes computation to fail");
}
