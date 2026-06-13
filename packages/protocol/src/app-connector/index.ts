import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Policy } from "../policy/index.js";

export namespace AppConnector {
  const nonEmptyString = z.string().min(1);
  const commandArgs = z.array(nonEmptyString);
  const positiveInteger = z.number().int().positive();

  export const EvidenceEmitter = z.enum([
    "exit_code",
    "diff",
    "test_result",
    "tool_call",
    "token_usage",
    "artifact",
    "log_event",
  ]);
  export type EvidenceEmitter = z.infer<typeof EvidenceEmitter>;

  export const InitialAutonomy = z.enum(["approval_required", "supervised", "autonomous"]);
  export type InitialAutonomy = z.infer<typeof InitialAutonomy>;

  export const Detect = z
    .object({
      command: nonEmptyString,
      args: commandArgs.optional(),
      versionPattern: nonEmptyString.optional(),
      testedVersions: nonEmptyString,
    })
    .strict();
  export type Detect = z.infer<typeof Detect>;

  export const Spawn = z
    .object({
      command: nonEmptyString,
      args: commandArgs.optional(),
      promptArgument: nonEmptyString.optional(),
      cwd: nonEmptyString.optional(),
      env: z.record(nonEmptyString, nonEmptyString).optional(),
      timeoutMs: positiveInteger.optional(),
    })
    .strict();
  export type Spawn = z.infer<typeof Spawn>;

  const structuredLogsFields = {
    path: nonEmptyString,
    eventTimeField: nonEmptyString,
    messageField: nonEmptyString,
    tokenUsageField: nonEmptyString.optional(),
    tokenUsageMode: z.enum(["cumulative", "delta"]).optional(),
    toolCallField: nonEmptyString.optional(),
  };

  export const Logs = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("jsonl"),
        ...structuredLogsFields,
      })
      .strict(),
    z
      .object({
        kind: z.literal("stream_json"),
        ...structuredLogsFields,
      })
      .strict(),
    z
      .object({
        kind: z.literal("text"),
        path: nonEmptyString,
      })
      .strict(),
  ]);
  export type Logs = z.infer<typeof Logs>;

  const bridgeResponseMode = z.enum(["stdout", "file", "webhook"]);

  export const QuestionBridge = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("hook"),
        command: nonEmptyString,
        args: commandArgs.optional(),
        promptField: nonEmptyString.optional(),
        responseMode: bridgeResponseMode.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("stdio"),
        promptField: nonEmptyString.optional(),
        responseMode: bridgeResponseMode.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("none"),
      })
      .strict(),
  ]);
  export type QuestionBridge = z.infer<typeof QuestionBridge>;

  export const CompletionReport = z
    .object({
      finalMessage: z.enum(["stdout", "stderr", "log", "artifact"]),
      artifactGlobs: z.array(nonEmptyString).optional(),
    })
    .strict();
  export type CompletionReport = z.infer<typeof CompletionReport>;

  export const Evidence = z
    .object({
      emits: z.array(EvidenceEmitter).min(1),
      completionReport: CompletionReport.optional(),
    })
    .strict();
  export type Evidence = z.infer<typeof Evidence>;

  export const Requires = z
    .object({
      credentials: z.array(nonEmptyString).optional(),
      capabilities: z.array(nonEmptyString).optional(),
      permissions: z.array(Policy.Permission).optional(),
    })
    .strict();
  export type Requires = z.infer<typeof Requires>;

  export const Profile = z
    .object({
      executorKind: z.literal("local_cli_agent"),
      taskTypes: z.array(nonEmptyString).min(1),
      defaultTimeoutMs: positiveInteger.optional(),
      defaultMaxAttempts: positiveInteger.optional(),
      initialAutonomy: InitialAutonomy.optional(),
    })
    .strict();
  export type Profile = z.infer<typeof Profile>;

  export const Definition = z
    .object({
      id: nonEmptyString,
      name: nonEmptyString,
      version: nonEmptyString,
      description: nonEmptyString,
      detect: Detect,
      spawn: Spawn,
      logs: Logs.optional(),
      questionBridge: QuestionBridge.optional(),
      evidence: Evidence,
      requires: Requires,
      profile: Profile,
    })
    .strict();
  export type Definition = z.infer<typeof Definition>;

  export const InstallationStatus = z.enum([
    "registered",
    "pending_consent",
    "consented",
    "enabled",
    "disabled",
    "verification_failed",
  ]);
  export type InstallationStatus = z.infer<typeof InstallationStatus>;

  export const Consent = z
    .object({
      grantedBy: nonEmptyString,
      grantedAt: positiveInteger,
      credentials: z.array(nonEmptyString).optional(),
      capabilities: z.array(nonEmptyString).optional(),
      permissions: z.array(Policy.Permission).optional(),
    })
    .strict();
  export type Consent = z.infer<typeof Consent>;

  export const Installation = z
    .object({
      id: nonEmptyString,
      connectorId: nonEmptyString,
      connectorVersion: nonEmptyString,
      definition: Definition,
      detectedVersion: nonEmptyString.optional(),
      testedVersions: nonEmptyString,
      status: InstallationStatus,
      registeredBy: nonEmptyString,
      consent: Consent.optional(),
      createdAt: positiveInteger,
      updatedAt: positiveInteger,
    })
    .strict()
    .refine((record) => record.definition.id === record.connectorId, {
      message: "definition id must match connectorId",
      path: ["definition", "id"],
    })
    .refine((record) => record.definition.version === record.connectorVersion, {
      message: "definition version must match connectorVersion",
      path: ["definition", "version"],
    })
    .refine((record) => record.status !== "enabled" || record.consent !== undefined, {
      message: "enabled installation requires owner consent",
      path: ["consent"],
    });
  export type Installation = z.infer<typeof Installation>;

  export const VerificationFailureReason = z.enum([
    "missing_candidate",
    "detect_failed",
    "unsupported_version",
  ]);
  export type VerificationFailureReason = z.infer<typeof VerificationFailureReason>;

  const VerificationEventBase = z.object({
    traceId: nonEmptyString,
    time: positiveInteger,
    installationId: nonEmptyString,
    connectorId: nonEmptyString,
    connectorVersion: nonEmptyString,
    reason: VerificationFailureReason,
    testedVersions: nonEmptyString,
    detectedVersion: nonEmptyString.optional(),
    diagnostic: nonEmptyString.max(512).optional(),
  });

  export namespace Events {
    export const VerificationFailed = BusEvent.define(
      "app_connector.verification.failed",
      VerificationEventBase,
    );
  }
}
