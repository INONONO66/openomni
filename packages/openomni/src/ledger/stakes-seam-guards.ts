import type { StakesValue } from "./stakes-contract.js";
import {
  StakesBrokerError,
  type CompletionStakesBinding,
  type StakesInjectionDenial,
  type VoiceAuthorizationRequest,
  type VoiceStakesBinding,
} from "./stakes-seam-contract.js";

export type StakesTokenRecord =
  | {
      readonly surface: "work.complete.pre";
      readonly binding: CompletionStakesBinding;
      readonly stakes: StakesValue;
    }
  | {
      readonly surface: "authorized_voice";
      readonly binding: VoiceStakesBinding;
      readonly stakes: StakesValue;
    };

export function assertStakesBinding(
  stakes: StakesValue,
  binding: CompletionStakesBinding | VoiceStakesBinding,
): void {
  if (stakes.window.ownerKey !== binding.ownerKey || stakes.windowRef !== binding.windowRef) {
    throw new StakesBrokerError("binding_mismatch", binding.surface);
  }
}

export function tokenRecord(
  records: WeakMap<object, StakesTokenRecord>,
  token: unknown,
): StakesTokenRecord | undefined {
  if ((typeof token !== "object" && typeof token !== "function") || token === null) {
    return undefined;
  }
  return records.get(token);
}

export function createCapabilityToken<T extends StakesInjectionDenial["surface"]>(
  surface: T,
): Readonly<{ surface: T }> {
  return Object.freeze(Object.assign(() => undefined, { surface }));
}

export function sameCompletionBinding(
  left: CompletionStakesBinding,
  right: CompletionStakesBinding,
): boolean {
  return (
    sameBaseBinding(left, right) &&
    left.workItemHash === right.workItemHash &&
    left.requestId === right.requestId &&
    left.contractRevision === right.contractRevision &&
    left.expectedHead === right.expectedHead
  );
}
export function sameVoiceBinding(left: VoiceStakesBinding, right: VoiceStakesBinding): boolean {
  return (
    sameBaseBinding(left, right) &&
    left.evaluationId === right.evaluationId &&
    left.authorizationReceiptRef === right.authorizationReceiptRef
  );
}

export function sameVoiceAuthorization(
  left: VoiceAuthorizationRequest,
  right: VoiceAuthorizationRequest,
): boolean {
  return (
    left.ownerKey === right.ownerKey &&
    left.evaluationId === right.evaluationId &&
    left.authorizationReceiptRef === right.authorizationReceiptRef &&
    left.actionRef === right.actionRef &&
    left.windowRef === right.windowRef &&
    left.asOfOwnerSeq === right.asOfOwnerSeq
  );
}

export function denied(
  code: StakesInjectionDenial["code"],
  surface: StakesInjectionDenial["surface"],
): { readonly ok: false; readonly denial: StakesInjectionDenial } {
  return Object.freeze({
    ok: false,
    denial: Object.freeze({ code, surface }),
  });
}

function sameBaseBinding(
  left: CompletionStakesBinding | VoiceStakesBinding,
  right: CompletionStakesBinding | VoiceStakesBinding,
): boolean {
  return (
    left.ownerKey === right.ownerKey &&
    left.actionRef === right.actionRef &&
    left.windowRef === right.windowRef &&
    left.asOfOwnerSeq === right.asOfOwnerSeq &&
    left.calculatorVersion === right.calculatorVersion &&
    left.basisRef === right.basisRef &&
    left.ledgerRangeDigest === right.ledgerRangeDigest &&
    left.noveltyBasisDigest === right.noveltyBasisDigest
  );
}
