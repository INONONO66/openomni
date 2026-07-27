import * as Schema from "./schemas.js";

export namespace WorkItem {
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

  export const CompletionReport = Schema.CompletionReport;
  export type CompletionReport = Schema.CompletionReport;
}
