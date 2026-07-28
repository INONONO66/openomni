import type { Ingress } from "@openomni/protocol";
import { z } from "zod";
import type { SecretRegistry } from "@openomni/llm/credential-runtime";

import {
  DispatchRuntime,
  createResidentDispatchHandlers,
  type DispatchOwners,
  type ToolEffectLedgerPortV1,
  type WorkspaceIdentity,
} from "@openomni/openomni";
import {
  createConnectorEndpointProcessDriver,
  type ConnectorEndpointCredentialMap,
  type ConnectorEndpointKernelQueries,
  type ConnectorEndpointKernelTransitions,
  type ConnectorQuestionBridgeHandler,
} from "../connector/process-driver.js";
import type { ConnectorArtifactWriter } from "../connector/log.js";

export interface ServerDispatchOwnersConfig {
  readonly coordinator: NonNullable<DispatchOwners["coordinator"]>;
  readonly residentRuntime: NonNullable<DispatchOwners["residentRuntime"]>;
  readonly credentials: ConnectorEndpointCredentialMap;
  readonly secretRegistry: SecretRegistry;
  readonly ledgerQueries: ConnectorEndpointKernelQueries;
  readonly ledgerTransitions: ConnectorEndpointKernelTransitions;
  readonly artifactWriter: ConnectorArtifactWriter;
  readonly connectorEffects: ToolEffectLedgerPortV1;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly waitKernel: Parameters<typeof createResidentDispatchHandlers>[0]["waitKernel"];
  readonly authorityQueries: ConstructorParameters<typeof DispatchRuntime>[0]["authorityQueries"];
  readonly model: {
    readonly providerID: string;
    readonly id: string;
  };
  readonly residentAgentResolver: {
    resolve(agentName: string, event: Ingress.InternalEvent): Promise<Ingress.AgentDef>;
  };
}

const residentAskHandlerOutput = z
  .object({
    status: z.literal("completed"),
    output: z
      .object({
        output: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

function createQuestionBridgeHandler(
  config: ServerDispatchOwnersConfig,
): ConnectorQuestionBridgeHandler {
  const handlers = createResidentDispatchHandlers({
    residentRuntime: config.residentRuntime,
    defaultModel: { provider: config.model.providerID, id: config.model.id },
    agentResolver: config.residentAgentResolver,
    waitKernel: config.waitKernel,
  });
  const dispatchRuntime = new DispatchRuntime({
    waitKernel: config.waitKernel,
    authorityQueries: config.authorityQueries,
  });
  dispatchRuntime.register("resident.ask", handlers["resident.ask"]);

  return async (request) => {
    const result = await dispatchRuntime.submit(
      {
        action: "resident.ask",
        target: { kind: "resident", sessionId: request.residentSessionId },
        payload: `Connector worker run ${request.runId} asks Resident:\n\n${request.prompt}`,
        wait: true,
      },
      {
        sessionId: request.sessionId,
        runId: request.runId,
        actorKind: "worker",
        actorId: `${request.sessionId}:${request.runId}`,
        trustTier: "assigned_worker",
        signal: request.signal,
      },
    );
    const parsed = residentAskHandlerOutput.safeParse(result);
    if (!parsed.success) {
      throw new Error(
        `resident.ask returned an invalid question response: ${parsed.error.message}`,
      );
    }
    return parsed.data.output.output;
  };
}

export function createServerDispatchOwners(config: ServerDispatchOwnersConfig): DispatchOwners {
  return {
    coordinator: config.coordinator,
    residentRuntime: config.residentRuntime,
    connectorEndpointDriver: createConnectorEndpointProcessDriver({
      credentials: config.credentials,
      secretRegistry: config.secretRegistry,
      questionBridge: createQuestionBridgeHandler(config),
      kernelQueries: config.ledgerQueries,
      kernelTransitions: config.ledgerTransitions,
      artifactWriter: config.artifactWriter,
      effects: config.connectorEffects,
      workspaceIdentity: config.workspaceIdentity,
    }),
    defaultModel: { provider: config.model.providerID, id: config.model.id },
  };
}
