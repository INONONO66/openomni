import { z } from "zod";
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

  export const Logs = z
    .object({
      kind: z.enum(["jsonl", "stream_json", "text"]),
      path: nonEmptyString,
      eventTimeField: nonEmptyString.optional(),
      messageField: nonEmptyString.optional(),
    })
    .strict();
  export type Logs = z.infer<typeof Logs>;

  export const QuestionBridge = z
    .object({
      kind: z.enum(["hook", "stdio", "none"]),
      command: nonEmptyString.optional(),
      args: commandArgs.optional(),
      promptField: nonEmptyString.optional(),
      responseMode: z.enum(["stdout", "file", "webhook"]).optional(),
    })
    .strict();
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
}
