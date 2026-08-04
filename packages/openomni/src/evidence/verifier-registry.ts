import * as Contract from "./verifier-registry-contract.js";
import { createRegistry } from "./verifier-registry-core.js";
import { FrozenNliModelFingerprint as pinnedModelFingerprint } from "./verifier-frozen-nli-model.js";

const PublicContract = Contract.createVerifierRegistrySchemas();

export namespace VerifierRegistry {
  export const ObligationKind = PublicContract.ObligationKind;
  export type ObligationKind = Contract.ObligationKind;
  export const AssertedOnlyKind = PublicContract.AssertedOnlyKind;
  export type AssertedOnlyKind = Contract.AssertedOnlyKind;
  export const ResultStatus = PublicContract.ResultStatus;
  export type ResultStatus = Contract.ResultStatus;
  export const SandboxCapability = PublicContract.SandboxCapability;
  export type SandboxCapability = Contract.SandboxCapability;
  export const ForbiddenAction = PublicContract.ForbiddenAction;
  export type ForbiddenAction = Contract.ForbiddenAction;
  export const JsonValue = PublicContract.JsonValue;
  export type JsonValue = Contract.JsonValue;
  export const Obligation = PublicContract.Obligation;
  export type Obligation = Contract.Obligation;
  export const VerifierProgram = PublicContract.VerifierProgram;
  export type VerifierProgram = Contract.VerifierProgram;
  export const VerificationRequest = PublicContract.VerificationRequest;
  export type VerificationRequest = Contract.VerificationRequest;
  export const VerificationResult = PublicContract.VerificationResult;
  export type VerificationResult = Contract.VerificationResult;
  export const VerificationErrorCode = PublicContract.VerificationErrorCode;
  export type VerificationErrorCode = Contract.VerificationErrorCode;
  export const VerificationError = PublicContract.VerificationError;
  export type VerificationError = Contract.VerificationError;
  export const VerificationFact = PublicContract.VerificationFact;
  export type VerificationFact = Contract.VerificationFact;
  export type Registry = Contract.Registry;
  export const FrozenNliModelFingerprint = pinnedModelFingerprint;
  export const create = createRegistry;
}
