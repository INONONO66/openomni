import { z } from "zod";
import { snapshotFirstJsonSchema } from "../evidence/verifier-conformance-canonical.js";
import { createStakesSchemas, type StakesValue } from "./stakes-contract.js";
import { computeStakes } from "./stakes-compute.js";
import {
  CompletionBinding,
  StakesBrokerError,
  VoiceBinding,
  type CompletionStakesBinding,
  type CompletionStakesInjection,
  type CompletionStakesToken,
  type StakesAuthorityPort,
  type StakesInjectionDenial,
  type VoiceStakesBinding,
  type VoiceStakesInjection,
  type VoiceStakesToken,
  type VoiceAuthorizationRequest,
} from "./stakes-seam-contract.js";

export { StakesBrokerError } from "./stakes-seam-contract.js";
export type {
  CompletionStakesBinding,
  CompletionStakesContext,
  CompletionStakesInjection,
  CompletionStakesToken,
  StakesAuthorityPort,
  StakesAuthorityRequest,
  StakesAuthoritySnapshot,
  StakesInjectionDenial,
  VoiceStakesBinding,
  VoiceStakesContext,
  VoiceStakesInjection,
  VoiceStakesToken,
  VoiceAuthorizationRequest,
  VoiceAuthorizationSnapshot,
} from "./stakes-seam-contract.js";

type StakesTokenRecord =
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

export type StakesBroker = ReturnType<typeof createStakesBroker>;

export function createStakesBroker(authority: StakesAuthorityPort) {
  const issuedTokens = new WeakMap<object, StakesTokenRecord>();
  const schemas = createStakesSchemas();
  const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
  const AuthoritySnapshot = snapshotFirstJsonSchema(
    z
      .object({
        action: schemas.StakesAction,
        state: schemas.StakesWindowedLedgerState,
        basisRef: digest,
        asOfOwnerSeq: z.number().int().safe().nonnegative(),
        ledgerRangeDigest: digest,
        noveltyBasisDigest: digest,
      })
      .strict()
      .readonly(),
  );
  const VoiceAuthorization = snapshotFirstJsonSchema(
    z
      .object({
        ownerKey: z.string().min(1).max(256),
        evaluationId: z.string().min(1).max(256),
        authorizationReceiptRef: digest,
        actionRef: z.string().min(1).max(256),
        windowRef: digest,
        asOfOwnerSeq: z.number().int().safe().nonnegative(),
      })
      .strict()
      .readonly(),
  );

  function issueCompletion(bindingInput: CompletionStakesBinding): CompletionStakesToken {
    const binding = CompletionBinding.parse(bindingInput);
    const stakes = readAuthoritativeStakes(binding);
    assertStakesBinding(stakes, binding);
    const token = Object.freeze({ surface: "work.complete.pre" as const });
    issuedTokens.set(token, { surface: "work.complete.pre", binding, stakes });
    return token;
  }

  function issueVoice(bindingInput: VoiceStakesBinding): VoiceStakesToken {
    const binding = VoiceBinding.parse(bindingInput);
    assertVoiceAuthorization(binding);
    const stakes = readAuthoritativeStakes(binding);
    assertStakesBinding(stakes, binding);
    const token = Object.freeze({ surface: "authorized_voice" as const });
    issuedTokens.set(token, { surface: "authorized_voice", binding, stakes });
    return token;
  }

  function assertVoiceAuthorization(binding: VoiceStakesBinding): void {
    const request: VoiceAuthorizationRequest = Object.freeze({
      ownerKey: binding.ownerKey,
      evaluationId: binding.evaluationId,
      authorizationReceiptRef: binding.authorizationReceiptRef,
      actionRef: binding.actionRef,
      windowRef: binding.windowRef,
      asOfOwnerSeq: binding.asOfOwnerSeq,
    });
    const authorization = VoiceAuthorization.parse(authority.readVoiceAuthorization(request));
    if (!sameVoiceAuthorization(request, authorization)) {
      throw new StakesBrokerError("binding_mismatch", binding.surface);
    }
  }

  function readAuthoritativeStakes(
    binding: CompletionStakesBinding | VoiceStakesBinding,
  ): StakesValue {
    const request = Object.freeze({
      ownerKey: binding.ownerKey,
      actionRef: binding.actionRef,
      windowRef: binding.windowRef,
      asOfOwnerSeq: binding.asOfOwnerSeq,
      calculatorVersion: binding.calculatorVersion,
      basisRef: binding.basisRef,
      ledgerRangeDigest: binding.ledgerRangeDigest,
      noveltyBasisDigest: binding.noveltyBasisDigest,
    });
    const snapshot = AuthoritySnapshot.parse(authority.read(request));
    if (
      snapshot.basisRef !== request.basisRef ||
      snapshot.asOfOwnerSeq !== request.asOfOwnerSeq ||
      snapshot.ledgerRangeDigest !== request.ledgerRangeDigest ||
      snapshot.noveltyBasisDigest !== request.noveltyBasisDigest ||
      snapshot.action.actionId !== request.actionRef
    ) {
      throw new StakesBrokerError("binding_mismatch", binding.surface);
    }
    return computeStakes(snapshot.action, snapshot.state);
  }

  function injectCompletion(token: unknown, input: unknown): CompletionStakesInjection {
    const binding = CompletionBinding.safeParse(input);
    if (!binding.success) return denied("invalid_subject", "work.complete.pre");
    const record = tokenRecord(issuedTokens, token);
    if (record === undefined) return denied("forged_local_value", "work.complete.pre");
    if (record.surface !== "work.complete.pre") {
      return denied("surface_mismatch", "work.complete.pre");
    }
    if (!sameCompletionBinding(record.binding, binding.data)) {
      return denied("binding_mismatch", "work.complete.pre");
    }
    return {
      ok: true,
      context: Object.freeze({
        surface: "work.complete.pre",
        workItemHash: binding.data.workItemHash,
        stakes: record.stakes,
      }),
    };
  }

  function injectVoice(token: unknown, input: unknown): VoiceStakesInjection {
    const binding = VoiceBinding.safeParse(input);
    if (!binding.success) return denied("invalid_subject", "authorized_voice");
    const record = tokenRecord(issuedTokens, token);
    if (record === undefined) return denied("forged_local_value", "authorized_voice");
    if (record.surface !== "authorized_voice") {
      return denied("surface_mismatch", "authorized_voice");
    }
    if (!sameVoiceBinding(record.binding, binding.data)) {
      return denied("binding_mismatch", "authorized_voice");
    }
    return {
      ok: true,
      context: Object.freeze({
        surface: "authorized_voice",
        evaluationId: binding.data.evaluationId,
        authorizationReceiptRef: binding.data.authorizationReceiptRef,
        stakes: record.stakes,
      }),
    };
  }

  return Object.freeze({
    issuer: Object.freeze({ issueCompletion, issueVoice }),
    completion: Object.freeze({ inject: injectCompletion }),
    voice: Object.freeze({ inject: injectVoice }),
  });
}

function assertStakesBinding(
  stakes: StakesValue,
  binding: CompletionStakesBinding | VoiceStakesBinding,
): void {
  if (stakes.window.ownerKey !== binding.ownerKey || stakes.windowRef !== binding.windowRef) {
    throw new StakesBrokerError("binding_mismatch", binding.surface);
  }
}

function tokenRecord(
  records: WeakMap<object, StakesTokenRecord>,
  token: unknown,
): StakesTokenRecord | undefined {
  if (typeof token !== "object" || token === null) return undefined;
  return records.get(token);
}

function sameCompletionBinding(
  left: CompletionStakesBinding,
  right: CompletionStakesBinding,
): boolean {
  return (
    sameBaseBinding(left, right) &&
    left.workItemHash === right.workItemHash &&
    left.contractRevision === right.contractRevision
  );
}

function sameVoiceBinding(left: VoiceStakesBinding, right: VoiceStakesBinding): boolean {
  return (
    sameBaseBinding(left, right) &&
    left.evaluationId === right.evaluationId &&
    left.authorizationReceiptRef === right.authorizationReceiptRef
  );
}

function sameVoiceAuthorization(
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

function denied(
  code: StakesInjectionDenial["code"],
  surface: StakesInjectionDenial["surface"],
): { readonly ok: false; readonly denial: StakesInjectionDenial } {
  return { ok: false, denial: { code, surface } };
}
