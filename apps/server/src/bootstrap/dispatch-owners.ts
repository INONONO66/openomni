import { z } from "zod";
import {
  createLocalCliAgentRuntime,
  createResidentDispatchHandlers,
  type DispatchOwners,
  type LocalCliQuestionBridgeHandler,
} from "@openomni/openomni";

export interface ServerDispatchOwnersConfig {
  readonly coordinator: NonNullable<DispatchOwners["coordinator"]>;
  readonly residentRuntime: NonNullable<DispatchOwners["residentRuntime"]>;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly model?: {
    readonly providerID: string;
    readonly id: string;
  };
}

const residentAskHandlerOutput = z
  .object({
    output: z
      .object({
        output: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

function createQuestionBridgeHandler(
  config: ServerDispatchOwnersConfig,
): LocalCliQuestionBridgeHandler | undefined {
  if (config.model === undefined) return undefined;

  const handlers = createResidentDispatchHandlers({
    residentRuntime: config.residentRuntime,
    defaultModel: { provider: config.model.providerID, id: config.model.id },
  });
  return async (request) => {
    const result = await handlers["resident.ask"](
      {
        dispatchId: crypto.randomUUID(),
        action: "resident.ask",
        target: { kind: "resident", sessionId: request.residentSessionId },
        payload: `Local CLI worker run ${request.runId} asks Resident:\n\n${request.prompt}`,
        wait: true,
        actor: {
          kind: "worker",
          actorId: `${request.sessionId}:${request.runId}`,
          sessionId: request.sessionId,
          runId: request.runId,
        },
        sessionId: request.sessionId,
        runId: request.runId,
        submittedAt: Date.now(),
      },
      {
        sessionId: request.sessionId,
        runId: request.runId,
        signal: request.signal,
      },
    );
    const parsed = residentAskHandlerOutput.safeParse(result);
    if (!parsed.success) throw new Error("resident.ask returned an invalid question response");
    return parsed.data.output.output;
  };
}

export function createServerDispatchOwners(config: ServerDispatchOwnersConfig): DispatchOwners {
  return {
    coordinator: config.coordinator,
    residentRuntime: config.residentRuntime,
    localCliAgentRuntime: createLocalCliAgentRuntime({
      credentials: config.credentials ?? {},
      questionBridge: createQuestionBridgeHandler(config),
    }),
    ...(config.model
      ? { defaultModel: { provider: config.model.providerID, id: config.model.id } }
      : {}),
  };
}
