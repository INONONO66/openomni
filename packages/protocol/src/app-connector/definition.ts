import { z } from "zod";
import { Policy } from "../policy/index.js";

export const nonEmptyString = z.string().min(1);
const commandArgs = z.array(nonEmptyString);
export const positiveInteger = z.number().int().positive();

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

export const DriverInstallScope = z.enum(["user", "workspace", "repository"]);
export type DriverInstallScope = z.infer<typeof DriverInstallScope>;

export const SubmitMode = z.enum(["spawn", "hook", "plugin", "api"]);
export type SubmitMode = z.infer<typeof SubmitMode>;

export const SubmitAck = z.enum(["submitted", "accepted", "running"]);
export type SubmitAck = z.infer<typeof SubmitAck>;

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
    stallTimeoutMs: positiveInteger.optional(),
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

// #498 K3 dictionary rule: "CompletionReport" is WorkItem-only vocabulary.
// This connector-side schema describes WHERE the connector's completion
// report material comes from (final message channel, artifact globs,
// read-back templates), so the TS symbol is ReportSource. The persisted/wire
// JSON field name inside installed connector definitions stays
// `evidence.completionReport` — installations and authored manifests are a
// persisted surface (see Evidence below).
export const ReportSource = z
  .object({
    finalMessage: z.enum(["stdout", "stderr", "log", "artifact"]),
    artifactGlobs: z.array(nonEmptyString).optional(),
    // Deliberately NOT unified with WorkItem.ReadBackRequest
    // (work-item/schemas.ts): targets here are templates that the server-side
    // read-back builder renders into the resolved http(s) URLs that schema
    // validates.
    readBackRequests: z
      .array(
        z
          .object({
            claimIndex: z.number().int().nonnegative(),
            criterionIndex: z.number().int().nonnegative(),
            request: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("url_fetch"),
                  target: nonEmptyString,
                  timeoutMs: positiveInteger.optional(),
                  maxBodyBytes: positiveInteger.optional(),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("api_query"),
                  target: nonEmptyString,
                  method: z.enum(["GET", "HEAD"]).optional(),
                  timeoutMs: positiveInteger.optional(),
                  maxBodyBytes: positiveInteger.optional(),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("citation_match"),
                  target: nonEmptyString,
                  quotedText: nonEmptyString,
                  timeoutMs: positiveInteger.optional(),
                  maxBodyBytes: positiveInteger.optional(),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(5)
      .optional(),
  })
  .strict();
export type ReportSource = z.infer<typeof ReportSource>;

export const Evidence = z
  .object({
    emits: z.array(EvidenceEmitter).min(1),
    // JSON key deliberately stays `completionReport`: it is the persisted
    // shape of installed connector definitions (app_connector_installation
    // rows) and of authored connector manifests — renaming the key would
    // orphan every installed definition. TS-symbol-only rename (#498 K3).
    completionReport: ReportSource.optional(),
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

export const Driver = z
  .object({
    provider: nonEmptyString,
    install: z
      .object({
        scopes: z.array(DriverInstallScope).min(1),
        hooks: z.array(nonEmptyString).optional(),
        plugins: z.array(nonEmptyString).optional(),
      })
      .strict(),
    submit: z
      .object({
        mode: SubmitMode,
        ack: SubmitAck,
      })
      .strict(),
    observedEvents: z.array(nonEmptyString).default([]),
    emits: z.array(EvidenceEmitter).default([]),
  })
  .strict();
export type Driver = z.infer<typeof Driver>;

export const Profile = z
  .object({
    kind: z.literal("connector_endpoint"),
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
    driver: Driver,
    evidence: Evidence,
    requires: Requires,
    profile: Profile,
  })
  .strict();
export type Definition = z.infer<typeof Definition>;
