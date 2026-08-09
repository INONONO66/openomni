import * as AttemptContract from "./attempt.js";
import { Events as EventDescriptors } from "./events.js";
import {
  criterionId as createCriterionId,
  generateHash as createHash,
  sha256JsonRef as createSha256JsonRef,
} from "./hash.js";
import * as Schema from "./schemas.js";
import { deriveStatus as resolveStatus } from "./status.js";
import * as Completion from "./completion-admission.js";
import { hasContiguousReservationBridge as hasReservationBridge } from "./terminal-linkage.js";

export namespace WorkItem {
  export const Status = Schema.Status;
  export type Status = Schema.Status;

  export const Blocker = Schema.Blocker;
  export type Blocker = Schema.Blocker;

  export const ReadBackRequest = Schema.ReadBackRequest;
  export type ReadBackRequest = Schema.ReadBackRequest;

  export const ReadBackRequestEnvelope = Schema.ReadBackRequestEnvelope;
  export type ReadBackRequestEnvelope = Schema.ReadBackRequestEnvelope;

  export const ReadBackCheck = Schema.ReadBackCheck;
  export type ReadBackCheck = Schema.ReadBackCheck;

  export const Evidence = Schema.Evidence;
  export type Evidence = Schema.Evidence;

  export const ExecutorKind = Schema.ExecutorKind;
  export type ExecutorKind = Schema.ExecutorKind;

  export const Outcome = Schema.Outcome;
  export type Outcome = Schema.Outcome;

  export const CompletionReport = Completion.CompletionReport;
  export type CompletionReport = Completion.CompletionReport;
  export const canonicalCompletionReport = Completion.canonicalCompletionReport;
  export const completionReportReference = Completion.completionReportReference;

  export const Criterion = Completion.Criterion;
  export type Criterion = Completion.Criterion;

  export const Claim = Completion.Claim;
  export type Claim = Completion.Claim;

  export const Observation = Completion.Observation;
  export type Observation = Completion.Observation;

  export const ResultValue = Completion.ResultValue;
  export type ResultValue = Completion.ResultValue;

  export const CriterionResult = Completion.CriterionResult;
  export type CriterionResult = Completion.CriterionResult;

  export const ResultInvalidation = Completion.ResultInvalidation;
  export type ResultInvalidation = Completion.ResultInvalidation;

  export const VerificationErrorCode = Completion.VerificationErrorCode;
  export type VerificationErrorCode = Completion.VerificationErrorCode;

  export const VerificationErrorFact = Completion.VerificationErrorFact;
  export type VerificationErrorFact = Completion.VerificationErrorFact;

  export const EffectRecord = Completion.EffectRecord;
  export type EffectRecord = Completion.EffectRecord;

  export const CompletionOrigin = Completion.CompletionOrigin;
  export type CompletionOrigin = Completion.CompletionOrigin;

  export type CompletionIdentity = Completion.CompletionIdentity;

  export const CompletionSource = Completion.CompletionSource;
  export type CompletionSource = Completion.CompletionSource;

  export const CompletionSourceOrigin = Completion.CompletionSourceOrigin;
  export type CompletionSourceOrigin = Completion.CompletionSourceOrigin;

  export const CompletionSourceIdentity = Completion.CompletionSourceIdentity;
  export type CompletionSourceIdentity = Completion.CompletionSourceIdentity;

  export const projectCompletionOrigin = Completion.projectCompletionOrigin;
  export const projectCompletionSourceIdentity = Completion.projectCompletionSourceIdentity;

  export const CompletionDecision = Completion.CompletionDecision;
  export type CompletionDecision = Completion.CompletionDecision;

  export const CompletionRequest = Completion.CompletionRequest;
  export type CompletionRequest = Completion.CompletionRequest;

  export const CompletionAdmission = Completion.CompletionAdmission;
  export type CompletionAdmission = Completion.CompletionAdmission;

  export const CompletionRequestReservation = Completion.CompletionRequestReservation;
  export type CompletionRequestReservation = Completion.CompletionRequestReservation;

  export const CompletionTerminalReceipt = Completion.CompletionTerminalReceipt;
  export type CompletionTerminalReceipt = Completion.CompletionTerminalReceipt;

  export const CompletionFacts = Completion.CompletionFacts;
  export type CompletionFacts = Completion.CompletionFacts;
  export const emptyCompletionFacts = Completion.emptyCompletionFacts;
  export const hasContiguousReservationBridge = hasReservationBridge;

  export const VerificationGate = Schema.VerificationGate;
  export type VerificationGate = Schema.VerificationGate;

  export const Info = Schema.Info;
  export type Info = Schema.Info;

  export const AttemptId = AttemptContract.AttemptId;
  export type AttemptId = AttemptContract.AttemptId;

  export const Attempt = AttemptContract.Attempt;
  export type Attempt = AttemptContract.Attempt;

  export const ContentFingerprintInputs = AttemptContract.ContentFingerprintInputs;
  export type ContentFingerprintInputs = AttemptContract.ContentFingerprintInputs;

  export const ContentFingerprint = AttemptContract.ContentFingerprint;
  export type ContentFingerprint = AttemptContract.ContentFingerprint;

  export const EnvironmentFingerprintInputs = AttemptContract.EnvironmentFingerprintInputs;
  export type EnvironmentFingerprintInputs = AttemptContract.EnvironmentFingerprintInputs;

  export const EnvironmentFingerprint = AttemptContract.EnvironmentFingerprint;
  export type EnvironmentFingerprint = AttemptContract.EnvironmentFingerprint;

  export const EnvironmentSubsetField = AttemptContract.EnvironmentSubsetField;
  export type EnvironmentSubsetField = AttemptContract.EnvironmentSubsetField;

  export const CacheKey = AttemptContract.CacheKey;
  export type CacheKey = AttemptContract.CacheKey;

  export const ReplayKey = AttemptContract.ReplayKey;
  export type ReplayKey = AttemptContract.ReplayKey;

  export const NondeterminismCategory = AttemptContract.NondeterminismCategory;
  export type NondeterminismCategory = AttemptContract.NondeterminismCategory;

  export const NondeterminismManifest = AttemptContract.NondeterminismManifest;
  export type NondeterminismManifest = AttemptContract.NondeterminismManifest;

  export const canonicalDigest = AttemptContract.canonicalDigest;
  export const generateAttemptId = AttemptContract.generateAttemptId;
  export const contentFingerprintOf = AttemptContract.contentFingerprintOf;
  export const environmentFingerprintOf = AttemptContract.environmentFingerprintOf;
  export const cacheKeyOf = AttemptContract.cacheKeyOf;

  export const deriveStatus = resolveStatus;
  export const criterionId = createCriterionId;
  export const generateHash = createHash;
  export const sha256JsonRef = createSha256JsonRef;
  export const Events = EventDescriptors;
}
