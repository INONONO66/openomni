import { createLocalCliAgentRuntime, type DispatchOwners } from "@openomni/openomni";

export interface ServerDispatchOwnersConfig {
  readonly coordinator: NonNullable<DispatchOwners["coordinator"]>;
  readonly residentRuntime: NonNullable<DispatchOwners["residentRuntime"]>;
  readonly model?: {
    readonly providerID: string;
    readonly id: string;
  };
}

export function createServerDispatchOwners(config: ServerDispatchOwnersConfig): DispatchOwners {
  return {
    coordinator: config.coordinator,
    residentRuntime: config.residentRuntime,
    localCliAgentRuntime: createLocalCliAgentRuntime(),
    ...(config.model
      ? { defaultModel: { provider: config.model.providerID, id: config.model.id } }
      : {}),
  };
}
