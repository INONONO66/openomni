import { resolve } from "node:path";
import type { AppConnector } from "@openomni/protocol";

export interface LocalCliTemplateValues {
  readonly prompt: string;
  readonly worktree?: string;
  readonly runId: string;
  readonly sessionId: string;
}

export type LocalCliCredentialMap = Readonly<Record<string, string>>;

export interface LocalCliCredentialEnvSuccess {
  readonly ok: true;
  readonly env: Record<string, string>;
  readonly redactions: readonly string[];
}

export interface LocalCliCredentialEnvFailure {
  readonly ok: false;
  readonly error: string;
}

export type LocalCliCredentialEnvResult =
  | LocalCliCredentialEnvSuccess
  | LocalCliCredentialEnvFailure;

const REDACTED_CREDENTIAL = "[REDACTED]";
const QUESTION_BRIDGE_ENV_PREFIX = "OPENOMNI_QUESTION_BRIDGE_";
const templatePattern = /\{\{(prompt|worktree|runId|sessionId)\}\}/g;
const inheritedEnvKeys = ["PATH", "SYSTEMROOT", "SystemRoot", "WINDIR"] as const;

function valueForTemplateKey(key: string, values: LocalCliTemplateValues): string {
  switch (key) {
    case "prompt":
      return values.prompt;
    case "worktree":
      if (values.worktree === undefined) {
        throw new Error("local CLI spawn template requires workspaceRoot for {{worktree}}");
      }
      return values.worktree;
    case "runId":
      return values.runId;
    case "sessionId":
      return values.sessionId;
    default:
      throw new Error(`unsupported local CLI spawn template key: ${key}`);
  }
}

export function renderLocalCliTemplate(value: string, values: LocalCliTemplateValues): string {
  return value.replace(templatePattern, (_match, key: string) => valueForTemplateKey(key, values));
}

export function renderLocalCliArgs(
  spawn: AppConnector.Spawn,
  values: LocalCliTemplateValues,
): readonly string[] {
  return (spawn.args ?? []).map((arg) => renderLocalCliTemplate(arg, values));
}

export function renderLocalCliCwd(
  spawn: AppConnector.Spawn,
  values: LocalCliTemplateValues,
): string | undefined {
  if (spawn.cwd === undefined)
    return values.worktree === undefined ? undefined : resolve(values.worktree);
  return resolve(renderLocalCliTemplate(spawn.cwd, values));
}

export function renderLocalCliEnv(
  spawn: AppConnector.Spawn,
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: LocalCliTemplateValues,
  credentialEnv: Record<string, string>,
  questionBridgeRuntimeEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of inheritedEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (spawn.env !== undefined) {
    for (const key of Object.keys(spawn.env)) {
      if (key.startsWith(QUESTION_BRIDGE_ENV_PREFIX)) continue;
      const value = spawn.env[key];
      if (value === undefined) continue;
      env[key] = renderLocalCliTemplate(value, values);
    }
  }
  for (const [key, value] of Object.entries(renderQuestionBridgeEnv(questionBridge, values))) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(questionBridgeRuntimeEnv)) {
    env[key] = value;
  }
  for (const key of Object.keys(credentialEnv)) {
    if (key.startsWith(QUESTION_BRIDGE_ENV_PREFIX)) continue;
    const value = credentialEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function redactLocalCliCredentialValues(
  value: string,
  redactions: readonly string[],
): string {
  let redacted = value;
  for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join(REDACTED_CREDENTIAL);
  }
  return redacted;
}

export function resolveLocalCliCredentialEnv(
  installation: AppConnector.Installation,
  credentials: LocalCliCredentialMap,
): LocalCliCredentialEnvResult {
  const requiredCredentials = installation.definition.requires.credentials ?? [];
  const consentedCredentials = new Set(installation.consent?.credentials ?? []);
  const env: Record<string, string> = {};
  const redactions: string[] = [];

  for (const credentialName of requiredCredentials) {
    if (!consentedCredentials.has(credentialName)) {
      return {
        ok: false,
        error: `local CLI credential not consented: ${credentialName}`,
      };
    }
    const value = credentials[credentialName];
    if (value === undefined || value.length === 0) {
      return {
        ok: false,
        error: `local CLI credential unavailable: ${credentialName}`,
      };
    }
    env[credentialName] = value;
    redactions.push(value);
  }

  return { ok: true, env, redactions };
}

function renderQuestionBridgeEnv(
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: LocalCliTemplateValues,
): Record<string, string> {
  if (questionBridge === undefined || questionBridge.kind === "none") {
    return { OPENOMNI_QUESTION_BRIDGE_KIND: "none" };
  }

  const env: Record<string, string> = {
    OPENOMNI_QUESTION_BRIDGE_KIND: questionBridge.kind,
  };
  if (questionBridge.promptField !== undefined) {
    env.OPENOMNI_QUESTION_BRIDGE_PROMPT_FIELD = questionBridge.promptField;
  }
  if (questionBridge.responseMode !== undefined) {
    env.OPENOMNI_QUESTION_BRIDGE_RESPONSE_MODE = questionBridge.responseMode;
  }
  if (questionBridge.kind === "hook") {
    env.OPENOMNI_QUESTION_BRIDGE_COMMAND = renderLocalCliTemplate(questionBridge.command, values);
    env.OPENOMNI_QUESTION_BRIDGE_ARGS_JSON = JSON.stringify(
      (questionBridge.args ?? []).map((arg) => renderLocalCliTemplate(arg, values)),
    );
  }
  return env;
}
