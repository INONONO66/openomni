import * as Schema from "./definition.js";
import { Events as EventDescriptors } from "./events.js";
import * as InstallationSchema from "./installation.js";

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

  export const InstallationStatus = InstallationSchema.InstallationStatus;
  export type InstallationStatus = InstallationSchema.InstallationStatus;

  export const Consent = InstallationSchema.Consent;
  export type Consent = InstallationSchema.Consent;

  export const WorkspaceIdentity = InstallationSchema.WorkspaceIdentity;
  export type WorkspaceIdentity = InstallationSchema.WorkspaceIdentity;

  export const Installation = InstallationSchema.Installation;
  export type Installation = InstallationSchema.Installation;

  export const VerificationFailureReason = InstallationSchema.VerificationFailureReason;
  export type VerificationFailureReason = InstallationSchema.VerificationFailureReason;

  export const Events = EventDescriptors;
}
