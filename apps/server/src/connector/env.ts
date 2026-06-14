import { resolve } from "node:path";
import type { AppConnector } from "@openomni/protocol";

export interface ConnectorTemplateValues {
  readonly prompt: string;
  readonly worktree: string;
  readonly runId: string;
  readonly sessionId: string;
}

export type ConnectorEndpointCredentialMap = Readonly<Record<string, string>>;

interface ConnectorCredentialEnvSuccess {
  readonly ok: true;
  readonly env: Record<string, string>;
  readonly redactions: readonly string[];
}

interface ConnectorCredentialEnvFailure {
  readonly ok: false;
  readonly error: string;
}

export type ConnectorCredentialEnvResult =
  | ConnectorCredentialEnvSuccess
  | ConnectorCredentialEnvFailure;

const REDACTED_CREDENTIAL = "[REDACTED]";
const QUESTION_BRIDGE_ENV_PREFIX = "OPENOMNI_QUESTION_BRIDGE_";
const templatePattern = /\{\{(prompt|worktree|runId|sessionId)\}\}/g;
const inheritedEnvKeys = ["PATH", "SYSTEMROOT", "SystemRoot", "WINDIR"] as const;

function valueForTemplateKey(key: string, values: ConnectorTemplateValues): string {
  switch (key) {
    case "prompt":
      return values.prompt;
    case "worktree":
      return values.worktree;
    case "runId":
      return values.runId;
    case "sessionId":
      return values.sessionId;
    default:
      throw new Error(`unsupported connector process spawn template key: ${key}`);
  }
}

export function renderConnectorTemplate(value: string, values: ConnectorTemplateValues): string {
  return value.replace(templatePattern, (_match, key: string) => valueForTemplateKey(key, values));
}

export function renderConnectorArgs(
  spawn: AppConnector.Spawn,
  values: ConnectorTemplateValues,
): readonly string[] {
  return (spawn.args ?? []).map((arg) => renderConnectorTemplate(arg, values));
}

export function renderConnectorCwd(
  spawn: AppConnector.Spawn,
  values: ConnectorTemplateValues,
): string {
  if (spawn.cwd === undefined) return resolve(values.worktree);
  return resolve(renderConnectorTemplate(spawn.cwd, values));
}

export function renderConnectorEnv(
  spawn: AppConnector.Spawn,
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: ConnectorTemplateValues,
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
      env[key] = renderConnectorTemplate(value, values);
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

export function redactConnectorCredentialValues(
  value: string,
  redactions: readonly string[],
): string {
  let redacted = value;
  for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join(REDACTED_CREDENTIAL);
  }
  return redacted;
}

export function resolveConnectorCredentialEnv(
  installation: AppConnector.Installation,
  credentials: ConnectorEndpointCredentialMap,
): ConnectorCredentialEnvResult {
  const requiredCredentials = installation.definition.requires.credentials ?? [];
  const consentedCredentials = new Set(installation.consent?.credentials ?? []);
  const env: Record<string, string> = {};
  const redactions: string[] = [];

  for (const credentialName of requiredCredentials) {
    if (!consentedCredentials.has(credentialName)) {
      return {
        ok: false,
        error: `connector process credential not consented: ${credentialName}`,
      };
    }
    const value = credentials[credentialName];
    if (value === undefined || value.length === 0) {
      return {
        ok: false,
        error: `connector process credential unavailable: ${credentialName}`,
      };
    }
    env[credentialName] = value;
    redactions.push(value);
  }

  return { ok: true, env, redactions };
}

function renderQuestionBridgeEnv(
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: ConnectorTemplateValues,
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
    env.OPENOMNI_QUESTION_BRIDGE_COMMAND = renderConnectorTemplate(questionBridge.command, values);
    env.OPENOMNI_QUESTION_BRIDGE_ARGS_JSON = JSON.stringify(
      (questionBridge.args ?? []).map((arg) => renderConnectorTemplate(arg, values)),
    );
  }
  return env;
}
