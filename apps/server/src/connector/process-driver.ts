import { Execution, type AppConnector, type Dispatch } from "@openomni/protocol";
import type { SecretRegistry, SecretHandle } from "@openomni/llm/credential-runtime";
import {
  digestEffectValue,
  toWorkspaceRef,
  type ProductionSemanticServices,
  type ToolEffectLedgerPortV1,
  type WorkspaceIdentity,
} from "@openomni/openomni";
import { redactConnectorCredentialValues } from "./env.js";
import {
  ingestConnectorLogs,
  type ConnectorArtifactWriter,
  type ConnectorLogIngestion,
} from "./log.js";

import { runConnectorProcess, type ConnectorProcessOutcome } from "./process.js";
import type { ConnectorQuestionBridgeHandler } from "./question-bridge.js";
import { applyConnectorReadBackBuilders } from "./read-back-builder.js";

export type ConnectorEndpointCredentialMap = Readonly<Record<string, SecretHandle>>;

export type { ConnectorQuestionBridgeHandler } from "./question-bridge.js";

interface ConnectorEndpointProcessDriverInput {
  readonly command: Dispatch.Command;
  readonly executionRequest: Execution.Request;
  readonly installation: AppConnector.Installation;
}

export interface ConnectorEndpointKernelQueries {
  resolveInstallation(target: Dispatch.Target): Promise<AppConnector.Installation | undefined>;
}

export type ConnectorEndpointKernelTransitions = ProductionSemanticServices["connectorTransitions"];
export type ConnectorAttemptProjection = Awaited<
  ReturnType<ConnectorEndpointKernelTransitions["beginAttempt"]>
>["attempt"];

export interface ConnectorEndpointProcessDriverOptions {
  readonly credentials?: ConnectorEndpointCredentialMap;
  readonly questionBridge?: ConnectorQuestionBridgeHandler;
  readonly secretRegistry: SecretRegistry;
  readonly artifactWriter: ConnectorArtifactWriter;
  readonly effects: ToolEffectLedgerPortV1;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly kernelQueries: ConnectorEndpointKernelQueries;
  readonly kernelTransitions: ConnectorEndpointKernelTransitions;
}

export interface ConnectorEndpointProcessDriver {
  dispatch(input: ConnectorEndpointProcessDriverInput): Promise<Execution.Result>;
  readonly kernelQueries: ConnectorEndpointKernelQueries;
  readonly kernelTransitions: ConnectorEndpointKernelTransitions;
}

function trimOutput(value: string): string | undefined {
  const output = value.trim();
  return output.length === 0 ? undefined : output;
}

function buildOutput(
  installation: AppConnector.Installation,
  outcome: ConnectorProcessOutcome,
  logIngestion: ConnectorLogIngestion,
): string | undefined {
  const finalMessage = installation.definition.evidence.completionReport?.finalMessage ?? "stdout";
  if (finalMessage === "stderr") return trimOutput(outcome.stderr);
  if (finalMessage === "log") return trimOutput(logIngestion.finalMessage ?? "");
  return trimOutput(outcome.stdout);
}

function buildError(outcome: ConnectorProcessOutcome): string | undefined {
  if (outcome.error !== undefined) return outcome.error;
  const stderr = outcome.stderr.trim();
  if (outcome.status === "interrupted") {
    return stderr || "connector process timed out";
  }
  if (outcome.status === "failed") {
    const exit = outcome.exitCode === undefined ? "unknown" : String(outcome.exitCode);
    return stderr
      ? `${stderr}\nconnector process exited with code ${exit}`
      : `connector process exited with code ${exit}`;
  }
  return stderr.length === 0 ? undefined : stderr;
}

function buildFinishReason(outcome: ConnectorProcessOutcome): string {
  if (outcome.exitCode !== undefined) return `exit_code:${outcome.exitCode}`;
  if (outcome.status === "interrupted") return outcome.interruptionReason ?? "timeout";
  return "spawn_error";
}

function redactOutcome(
  outcome: ConnectorProcessOutcome,
  redactions: readonly string[],
  registry: SecretRegistry,
): ConnectorProcessOutcome {
  const sanitize = (boundary: string, value: string): string => {
    const exact = redactConnectorCredentialValues(value, redactions);
    return registry.sanitizeText(boundary, exact);
  };
  return {
    ...outcome,
    stdout: sanitize("connector.stdout", outcome.stdout),
    stderr: sanitize("connector.stderr", outcome.stderr),
    ...(outcome.error === undefined ? {} : { error: sanitize("connector.error", outcome.error) }),
  };
}

function sanitizeArtifactWriter(
  writer: ConnectorArtifactWriter,
  registry: SecretRegistry,
): ConnectorArtifactWriter {
  return {
    async putAndReference(input) {
      const content = registry.sanitizeText(
        "connector.artifact.content",
        new TextDecoder().decode(input.content),
      );
      await writer.putAndReference({
        ...input,
        title: registry.sanitizeText("connector.artifact.title", input.title),
        content: new TextEncoder().encode(content),
      });
    },
  };
}

function sanitizeExecutionResult(
  result: Execution.Result,
  registry: SecretRegistry,
): Execution.Result {
  return Execution.Result.parse(registry.sanitizeValue("connector.result", result));
}

function resolveResidentSessionId(command: Dispatch.Command, request: Execution.Request): string {
  return command.target.parentSessionId ?? command.actor.sessionId ?? request.sessionId;
}

type CredentialScopeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

async function withConnectorCredentials<T>(
  installation: AppConnector.Installation,
  options: ConnectorEndpointProcessDriverOptions,
  use: (env: Record<string, string>, redactions: readonly string[]) => Promise<T>,
): Promise<CredentialScopeResult<T>> {
  const required = installation.definition.requires.credentials ?? [];
  const consented = new Set(installation.consent?.credentials ?? []);
  const registry = options.secretRegistry;
  const handles = options.credentials ?? {};
  const env: Record<string, string> = {};
  const redactions: string[] = [];

  const materialize = async (index: number): Promise<CredentialScopeResult<T>> => {
    const credentialName = required[index];
    if (credentialName === undefined) return { ok: true, value: await use(env, redactions) };
    if (!consented.has(credentialName)) {
      return { ok: false, error: `connector process credential not consented: ${credentialName}` };
    }
    const handle = handles[credentialName];
    if (handle === undefined) {
      return { ok: false, error: `connector process credential unavailable: ${credentialName}` };
    }
    try {
      if (registry.describe(handle).providerId !== handle.providerId) {
        return { ok: false, error: `connector process credential unavailable: ${credentialName}` };
      }
    } catch {
      return { ok: false, error: `connector process credential unavailable: ${credentialName}` };
    }
    return registry.withMaterialized(handle, handle.providerId, async (credential) => {
      const bytes = credential.authType === "api" ? credential.key : credential.apiKey;
      if (bytes === undefined || bytes.byteLength === 0) {
        return { ok: false, error: `connector process credential unavailable: ${credentialName}` };
      }
      const value = new TextDecoder().decode(bytes);
      env[credentialName] = value;
      redactions.push(value);
      try {
        return await materialize(index + 1);
      } finally {
        delete env[credentialName];
        redactions.pop();
      }
    });
  };

  return materialize(0);
}

function canonicalEffectValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEffectValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalEffectValue(nested)]),
    );
  }
  return value;
}

function requireAcceptedEffectReceipt(
  receipt: Awaited<ReturnType<ToolEffectLedgerPortV1["appendIntent"]>>,
): void {
  if (receipt.version === "tool-effect-append-receipt-v1" && receipt.status === "accepted") return;
  throw new Error(
    `effect ledger denied: ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`,
  );
}

function connectorEffectIntent(
  input: ConnectorEndpointProcessDriverInput,
  workspace: WorkspaceIdentity,
) {
  const installation = input.installation;
  if (!installation.endpointId) throw new Error("connector effect requires an exact endpoint");
  const inputDigest = digestEffectValue(
    JSON.stringify(
      canonicalEffectValue({
        action: input.command.action,
        endpointId: installation.endpointId,
        installationId: installation.id,
        payload: input.command.payload,
        prompt: input.executionRequest.prompt,
      }),
    ),
  );
  const scope = Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(workspace),
    resources: [
      {
        version: "resource-scope-v1",
        kind: "connector",
        installationId: installation.id,
        definitionVersion: installation.connectorVersion,
      },
      {
        version: "resource-scope-v1",
        kind: "endpoint",
        targetDigest: digestEffectValue(installation.endpointId),
      },
    ],
    resolver: { id: "connector-installation-v1", version: "1", inputDigest },
    containment: "connector-declared",
    mutationClass: "unknown",
  });
  const sourceRef = digestEffectValue(
    JSON.stringify({
      version: "tool-effect-source-v1",
      sessionId: input.executionRequest.sessionId,
      runId: input.executionRequest.runId,
      toolCallId: input.command.dispatchId,
      operation: "connector.submit.v1",
      operationVersion: "1",
      scope,
    }),
  );
  return Object.freeze({
    version: "tool-effect-intent-v1" as const,
    effectId: `connector-effect:${sourceRef}`,
    sourceRef,
    toolCallId: input.command.dispatchId,
    operation: "connector.submit.v1",
    operationVersion: "1" as const,
    scope,
    execution: {
      sessionId: input.executionRequest.sessionId,
      runId: input.executionRequest.runId,
    },
  });
}

async function settleConnectorEffect(
  effects: ToolEffectLedgerPortV1,
  intent: ReturnType<typeof connectorEffectIntent>,
  status: "confirmed" | "failed" | "unknown",
): Promise<void> {
  requireAcceptedEffectReceipt(
    await effects.appendSettlement({
      version: "tool-effect-settlement-v1",
      effectId: intent.effectId,
      sourceRef: intent.sourceRef,
      status,
    }),
  );
}

export function createConnectorEndpointProcessDriver(
  options: ConnectorEndpointProcessDriverOptions,
): ConnectorEndpointProcessDriver {
  return {
    kernelQueries: options.kernelQueries,
    kernelTransitions: options.kernelTransitions,
    async dispatch(input): Promise<Execution.Result> {
      const request = input.executionRequest;
      const worktree = request.workspaceRoot;
      if (worktree === undefined || worktree.length === 0) {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed",
          finishReason: "worktree_unavailable",
          error: "connector endpoint process driver requires workspaceRoot worktree",
        };
      }
      if (worktree !== options.workspaceIdentity.canonicalRoot) {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed",
          finishReason: "workspace_scope_mismatch",
          error:
            "connector endpoint process driver workspaceRoot does not match its provisioned scope",
        };
      }
      const values = {
        prompt: request.prompt,
        worktree,
        runId: request.runId,
        sessionId: request.sessionId,
      };
      const credentialScope = await withConnectorCredentials(
        input.installation,
        options,
        async (credentialEnv, credentialRedactions) => {
          const intent = connectorEffectIntent(input, options.workspaceIdentity);
          requireAcceptedEffectReceipt(await options.effects.appendIntent(intent));
          let spawned: Awaited<ReturnType<typeof runConnectorProcess>>;
          try {
            spawned = await runConnectorProcess(
              input.installation.definition.spawn,
              input.installation.definition.logs,
              input.installation.definition.questionBridge,
              values,
              credentialEnv,
              options.questionBridge,
              resolveResidentSessionId(input.command, request),
            );
          } catch (error) {
            await settleConnectorEffect(options.effects, intent, "failed");
            throw options.secretRegistry.sanitizeError("connector.process", error);
          }
          const redactions = [...credentialRedactions, ...spawned.redactions];
          const outcome = redactOutcome(spawned.outcome, redactions, options.secretRegistry);
          await settleConnectorEffect(
            options.effects,
            intent,
            outcome.status === "succeeded"
              ? "confirmed"
              : outcome.status === "interrupted"
                ? "unknown"
                : "failed",
          );
          const logIngestion = await ingestConnectorLogs({
            connector: input.installation.definition,
            runId: request.runId,
            sessionId: request.sessionId,
            values,
            redactions,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            artifactWriter: sanitizeArtifactWriter(options.artifactWriter, options.secretRegistry),
          });
          return sanitizeExecutionResult(
            buildExecutionResult(input.installation, request, values, outcome, logIngestion),
            options.secretRegistry,
          );
        },
      );
      if (!credentialScope.ok) {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed",
          finishReason: "credential_unavailable",
          error: credentialScope.error,
        };
      }
      return credentialScope.value;
    },
  };
}

function buildExecutionResult(
  installation: AppConnector.Installation,
  request: Execution.Request,
  values: {
    readonly prompt: string;
    readonly worktree: string;
    readonly runId: string;
    readonly sessionId: string;
  },
  outcome: ConnectorProcessOutcome,
  logIngestion: ConnectorLogIngestion,
): Execution.Result {
  const output = buildOutput(installation, outcome, logIngestion);
  const builtOutput =
    outcome.status === "succeeded"
      ? applyConnectorReadBackBuilders({ connector: installation.definition, output, values })
      : { ok: true as const, output };
  if (!builtOutput.ok) {
    return {
      runId: request.runId,
      sessionId: request.sessionId,
      status: "failed",
      finishReason: "read_back_request_builder_failed",
      error: builtOutput.error,
    };
  }
  const error = buildError(outcome);
  return {
    runId: request.runId,
    sessionId: request.sessionId,
    status: outcome.status,
    finishReason: buildFinishReason(outcome),
    ...(builtOutput.output === undefined ? {} : { output: builtOutput.output }),
    ...(error === undefined ? {} : { error }),
    ...(logIngestion.usage === undefined ? {} : { usage: logIngestion.usage }),
    ...(logIngestion.artifacts.length === 0 ? {} : { artifacts: logIngestion.artifacts }),
    ...(logIngestion.logEvents.length === 0 ? {} : { logEvents: logIngestion.logEvents }),
  };
}
