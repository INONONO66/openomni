import { Events as EventDescriptors } from "./events.js";
import { generateHash as createHash } from "./hash.js";
import * as Schema from "./schemas.js";
import { deriveStatus as resolveStatus } from "./status.js";

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

  export const VerificationGate = Schema.VerificationGate;
  export type VerificationGate = Schema.VerificationGate;

  export const Info = Schema.Info;
  export type Info = Schema.Info;

  export const deriveStatus = resolveStatus;
  export const generateHash = createHash;
  export const Events = EventDescriptors;
}
