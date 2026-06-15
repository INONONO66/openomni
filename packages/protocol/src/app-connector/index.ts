import { Events as EventDescriptors } from "./events.js";
import * as Schema from "./schemas.js";

export namespace AppConnector {
  export const EvidenceEmitter = Schema.EvidenceEmitter;
  export type EvidenceEmitter = Schema.EvidenceEmitter;

  export const InitialAutonomy = Schema.InitialAutonomy;
  export type InitialAutonomy = Schema.InitialAutonomy;

  export const DriverInstallScope = Schema.DriverInstallScope;
  export type DriverInstallScope = Schema.DriverInstallScope;

  export const SubmitMode = Schema.SubmitMode;
  export type SubmitMode = Schema.SubmitMode;

  export const SubmitAck = Schema.SubmitAck;
  export type SubmitAck = Schema.SubmitAck;

  export const Detect = Schema.Detect;
  export type Detect = Schema.Detect;

  export const Spawn = Schema.Spawn;
  export type Spawn = Schema.Spawn;

  export const Logs = Schema.Logs;
  export type Logs = Schema.Logs;

  export const QuestionBridge = Schema.QuestionBridge;
  export type QuestionBridge = Schema.QuestionBridge;

  export const CompletionReport = Schema.CompletionReport;
  export type CompletionReport = Schema.CompletionReport;

  export const Evidence = Schema.Evidence;
  export type Evidence = Schema.Evidence;

  export const Requires = Schema.Requires;
  export type Requires = Schema.Requires;

  export const Driver = Schema.Driver;
  export type Driver = Schema.Driver;

  export const Profile = Schema.Profile;
  export type Profile = Schema.Profile;

  export const Definition = Schema.Definition;
  export type Definition = Schema.Definition;

  export const InstallationStatus = Schema.InstallationStatus;
  export type InstallationStatus = Schema.InstallationStatus;

  export const Consent = Schema.Consent;
  export type Consent = Schema.Consent;

  export const WorkspaceIdentity = Schema.WorkspaceIdentity;
  export type WorkspaceIdentity = Schema.WorkspaceIdentity;

  export const Installation = Schema.Installation;
  export type Installation = Schema.Installation;

  export const VerificationFailureReason = Schema.VerificationFailureReason;
  export type VerificationFailureReason = Schema.VerificationFailureReason;

  export const Events = EventDescriptors;
}
