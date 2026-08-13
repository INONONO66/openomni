import type { Ingress } from "@openomni/protocol";
import { z } from "zod";
import {
  DispatchRuntime,
  createResidentDispatchHandlers,
  type DispatchOwners,
} from "@openomni/openomni";
import {
  createConnectorEndpointDriver,
  type ConnectorQuestionBridgeHandler,
} from "../connector/index";

export interface ServerDispatchOwnersConfig {
  readonly coordinator: NonNullable<DispatchOwners["coordinator"]>;
  readonly residentRuntime: NonNullable<DispatchOwners["residentRuntime"]>;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly model?: {
    readonly providerID: string;
    readonly id: string;
  };
  readonly residentAgentResolver?: {
    resolve(agentName: string, event: Ingress.InternalEvent): Promise<Ingress.AgentDef>;
  };
  /** Ingress engine seam threaded to the resident.ask handlers (#549). */
  readonly ingress: NonNullable<DispatchOwners["ingress"]>;
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
): ConnectorQuestionBridgeHandler | undefined {
  const model = config.model;
  if (model === undefined) return undefined;

  const handlers = createResidentDispatchHandlers({
    residentRuntime: config.residentRuntime,
    defaultModel: { provider: model.providerID, id: model.id },
    ingress: config.ingress,
    ...(config.residentAgentResolver ? { agentResolver: config.residentAgentResolver } : {}),
  });
  const dispatchRuntime = new DispatchRuntime();
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
        traceId: request.traceId,
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
    ingress: config.ingress,
    connectorEndpointDriver: createConnectorEndpointDriver({
      credentials: config.credentials ?? {},
      questionBridge: createQuestionBridgeHandler(config),
    }),
    ...(config.model
      ? { defaultModel: { provider: config.model.providerID, id: config.model.id } }
      : {}),
  };
}
