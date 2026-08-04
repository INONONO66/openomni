import { z } from "zod";
import { snapshotFirstJsonSchema } from "../evidence/verifier-conformance-canonical.js";
import {
  STAKES_POLICY_VERSION,
  type StakesAction,
  type StakesValue,
  type StakesWindowedLedgerState,
} from "./stakes-contract.js";

const identifier = z.string().min(1).max(256);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sequence = z.number().int().safe().nonnegative();
const bindingFields = {
  ownerKey: identifier,
  actionRef: identifier,
  windowRef: digest,
  asOfOwnerSeq: sequence,
  calculatorVersion: z.literal(STAKES_POLICY_VERSION),
  basisRef: digest,
  ledgerRangeDigest: digest,
  noveltyBasisDigest: digest,
} as const;

export const CompletionBinding = snapshotFirstJsonSchema(
  z
    .object({
      ...bindingFields,
      surface: z.literal("work.complete.pre"),
      workItemHash: identifier,
      contractRevision: sequence,
    })
    .strict()
    .readonly(),
);
export const VoiceBinding = snapshotFirstJsonSchema(
  z
    .object({
      ...bindingFields,
      surface: z.literal("authorized_voice"),
      evaluationId: identifier,
      authorizationReceiptRef: digest,
    })
    .strict()
    .readonly(),
);

export type CompletionStakesBinding = z.infer<typeof CompletionBinding>;
export type VoiceStakesBinding = z.infer<typeof VoiceBinding>;
export type CompletionStakesToken = Readonly<{ surface: "work.complete.pre" }>;
export type VoiceStakesToken = Readonly<{ surface: "authorized_voice" }>;
export type StakesAuthorityRequest = Readonly<{
  ownerKey: string;
  actionRef: string;
  windowRef: string;
  asOfOwnerSeq: number;
  calculatorVersion: typeof STAKES_POLICY_VERSION;
  basisRef: string;
  ledgerRangeDigest: string;
  noveltyBasisDigest: string;
}>;
export type StakesAuthoritySnapshot = Readonly<{
  action: StakesAction;
  state: StakesWindowedLedgerState;
  basisRef: string;
  asOfOwnerSeq: number;
  ledgerRangeDigest: string;
  noveltyBasisDigest: string;
}>;
export type VoiceAuthorizationRequest = Readonly<{
  ownerKey: string;
  evaluationId: string;
  authorizationReceiptRef: string;
  actionRef: string;
  windowRef: string;
  asOfOwnerSeq: number;
}>;
export type VoiceAuthorizationSnapshot = VoiceAuthorizationRequest;
export type StakesAuthorityPort = Readonly<{
  read(request: StakesAuthorityRequest): StakesAuthoritySnapshot;
  readVoiceAuthorization(request: VoiceAuthorizationRequest): VoiceAuthorizationSnapshot;
}>;

export type StakesInjectionDenial = {
  readonly code: "invalid_subject" | "forged_local_value" | "surface_mismatch" | "binding_mismatch";
  readonly surface: "work.complete.pre" | "authorized_voice";
};
export type CompletionStakesContext = {
  readonly surface: "work.complete.pre";
  readonly workItemHash: string;
  readonly stakes: StakesValue;
};
export type VoiceStakesContext = {
  readonly surface: "authorized_voice";
  readonly evaluationId: string;
  readonly authorizationReceiptRef: string;
  readonly stakes: StakesValue;
};
export type CompletionStakesInjection =
  | { readonly ok: true; readonly context: CompletionStakesContext }
  | { readonly ok: false; readonly denial: StakesInjectionDenial };
export type VoiceStakesInjection =
  | { readonly ok: true; readonly context: VoiceStakesContext }
  | { readonly ok: false; readonly denial: StakesInjectionDenial };

export class StakesBrokerError extends Error {
  readonly name = "StakesBrokerError";

  constructor(
    readonly code: "binding_mismatch",
    readonly surface: StakesInjectionDenial["surface"],
  ) {
    super(`${code}: ${surface}`);
  }
}
