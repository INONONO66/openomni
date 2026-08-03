import * as Contract from "./verifier-registry-contract.js";
import { createRegistry } from "./verifier-registry-core.js";
import { FrozenNliModelFingerprint as pinnedModelFingerprint } from "./verifier-frozen-nli-model.js";

export namespace VerifierRegistry {
  export const ObligationKind = Contract.ObligationKind;
  export type ObligationKind = Contract.ObligationKind;
  export const AssertedOnlyKind = Contract.AssertedOnlyKind;
  export type AssertedOnlyKind = Contract.AssertedOnlyKind;
  export const ResultStatus = Contract.ResultStatus;
  export type ResultStatus = Contract.ResultStatus;
  export const SandboxCapability = Contract.SandboxCapability;
  export type SandboxCapability = Contract.SandboxCapability;
  export const ForbiddenAction = Contract.ForbiddenAction;
  export type ForbiddenAction = Contract.ForbiddenAction;
  export const JsonValue = Contract.JsonValue;
  export type JsonValue = Contract.JsonValue;
  export const Obligation = Contract.Obligation;
  export type Obligation = Contract.Obligation;
  export const VerifierProgram = Contract.VerifierProgram;
  export type VerifierProgram = Contract.VerifierProgram;
  export const VerificationRequest = Contract.VerificationRequest;
  export const VerificationResult = Contract.VerificationResult;
  export type VerificationResult = Contract.VerificationResult;
  export const VerificationErrorCode = Contract.VerificationErrorCode;
  export const VerificationError = Contract.VerificationError;
  export type VerificationError = Contract.VerificationError;
  export const VerificationFact = Contract.VerificationFact;
  export type VerificationFact = Contract.VerificationFact;
  export type Registry = Contract.Registry;
  export const FrozenNliModelFingerprint = pinnedModelFingerprint;
  export const create = createRegistry;
}
