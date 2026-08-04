import { Events as EventDescriptors } from "./events.js";
import { criterionId as createCriterionId, generateHash as createHash } from "./hash.js";
import * as Schema from "./schemas.js";
import { deriveStatus as resolveStatus } from "./status.js";
import * as Completion from "./completion-admission.js";
import { upcastLegacyCompletion as upcastCompletion } from "./completion-admission-upcast.js";

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

  export const CompletionReport = Schema.CompletionReport;
  export type CompletionReport = Schema.CompletionReport;

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

  export const EffectOutcome = Completion.EffectOutcome;
  export type EffectOutcome = Completion.EffectOutcome;

  export const EffectRecord = Completion.EffectRecord;
  export type EffectRecord = Completion.EffectRecord;

  export const CompletionOrigin = Completion.CompletionOrigin;
  export type CompletionOrigin = Completion.CompletionOrigin;

  export const CompletionDecision = Completion.CompletionDecision;
  export type CompletionDecision = Completion.CompletionDecision;

  export const CompletionContract = Completion.CompletionContract;
  export type CompletionContract = Completion.CompletionContract;

  export const CompletionRequest = Completion.CompletionRequest;
  export type CompletionRequest = Completion.CompletionRequest;

  export const CompletionAdmission = Completion.CompletionAdmission;
  export type CompletionAdmission = Completion.CompletionAdmission;

  export const CompletionTerminalReceipt = Completion.CompletionTerminalReceipt;
  export type CompletionTerminalReceipt = Completion.CompletionTerminalReceipt;

  export const CompletionFacts = Completion.CompletionFacts;
  export type CompletionFacts = Completion.CompletionFacts;
  export const emptyCompletionFacts = Completion.emptyCompletionFacts;
  export const upcastLegacyCompletion = upcastCompletion;

  export const VerificationGate = Schema.VerificationGate;
  export type VerificationGate = Schema.VerificationGate;

  export const Info = Schema.Info;
  export type Info = Schema.Info;

  export const deriveStatus = resolveStatus;
  export const criterionId = createCriterionId;
  export const generateHash = createHash;
  export const Events = EventDescriptors;
}
