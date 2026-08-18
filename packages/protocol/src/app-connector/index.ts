import * as Schema from "./definition.js";
import * as InstallationSchema from "./installation.js";

export namespace AppConnector {
  export const Spawn = Schema.Spawn;
  export type Spawn = Schema.Spawn;

  export const Logs = Schema.Logs;
  export type Logs = Schema.Logs;

  export const QuestionBridge = Schema.QuestionBridge;
  export type QuestionBridge = Schema.QuestionBridge;

  export const ReportSource = Schema.ReportSource;
  export type ReportSource = Schema.ReportSource;

  export const Requires = Schema.Requires;
  export type Requires = Schema.Requires;

  export const Definition = Schema.Definition;
  export type Definition = Schema.Definition;

  export const InstallationStatus = InstallationSchema.InstallationStatus;
  export type InstallationStatus = InstallationSchema.InstallationStatus;

  export const Consent = InstallationSchema.Consent;
  export type Consent = InstallationSchema.Consent;

  export const Installation = InstallationSchema.Installation;
  export type Installation = InstallationSchema.Installation;
}
