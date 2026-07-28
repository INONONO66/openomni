import {
  Execution,
  type Ipc,
  Model,
  type Policy,
  type RuntimeResource,
  type Tool,
  type ToolSelection,
} from "@openomni/protocol";
import type { AgentDefinition } from "./types";

type WorkerIdentityFacts = Ipc.CredentialProvisioningFrameV1["request"];

export interface RuntimeAgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly model: AgentDefinition["model"];
  readonly systemPrompt: string;
  readonly tools: ToolSelection.Selection;
  readonly permissions?: Policy.Permission;
  readonly policyPlan?: Policy.PolicyPlan;
  readonly budget?: AgentDefinition["budget"];
}

export namespace RuntimeAgentDefinition {
  export function create(definition: AgentDefinition): RuntimeAgentDefinition {
    return Object.freeze({
      name: definition.name,
      description: definition.description,
      model: Model.Ref.parse(definition.model),
      systemPrompt: definition.systemPrompt,
      tools: definition.tools,
      ...(definition.permissions === undefined ? {} : { permissions: definition.permissions }),
      ...(definition.policyPlan === undefined ? {} : { policyPlan: definition.policyPlan }),
      ...(definition.budget === undefined ? {} : { budget: definition.budget }),
    });
  }
}

export interface RuntimeToolCatalogEntry {
  readonly canonicalName: string;
  readonly exposedName: string;
  readonly source: Tool.Source;
  readonly category: ToolSelection.Category;
  readonly riskTier: Tool.RiskTier;
  readonly spec: Tool.Spec;
  readonly descriptor?: RuntimeResource.Descriptor;
  readonly mcpServer?: string;
}

export interface WorkerRuntimeConfig {
  readonly configEpoch: string;
  readonly model: Execution.Request["model"];
  readonly environment: Execution.LLMEnvironmentV1;
  readonly workspace: Execution.WorkspaceRefV1;
  readonly agents: readonly RuntimeAgentDefinition[];
  readonly toolCatalog: readonly RuntimeToolCatalogEntry[];
  readonly budget?: NonNullable<Execution.Request["budget"]>;
  readonly providerOptions?: NonNullable<Execution.Request["providerOptions"]>;
}

export interface WorkerRuntimeDefinition {
  readonly runtimeId: WorkerIdentityFacts["runtimeId"];
  readonly workerId: WorkerIdentityFacts["workerId"];
  readonly generation: WorkerIdentityFacts["generation"];
  readonly principalId: WorkerIdentityFacts["principalId"];
  readonly attempt: WorkerIdentityFacts["attempt"];
  readonly config: WorkerRuntimeConfig;
}

export namespace WorkerRuntimeDefinition {
  export function create(definition: WorkerRuntimeDefinition): WorkerRuntimeDefinition {
    const config = Object.freeze({
      configEpoch: definition.config.configEpoch,
      model: Model.Ref.parse(definition.config.model),
      environment: Execution.LLMEnvironmentV1.parse(definition.config.environment),
      workspace: Execution.WorkspaceRefV1.parse(definition.config.workspace),
      agents: Object.freeze(definition.config.agents.map(RuntimeAgentDefinition.create)),
      toolCatalog: Object.freeze(
        definition.config.toolCatalog.map((entry) =>
          Object.freeze({
            canonicalName: entry.canonicalName,
            exposedName: entry.exposedName,
            source: entry.source,
            category: entry.category,
            riskTier: entry.riskTier,
            spec: entry.spec,
            ...(entry.descriptor === undefined ? {} : { descriptor: entry.descriptor }),
            ...(entry.mcpServer === undefined ? {} : { mcpServer: entry.mcpServer }),
          }),
        ),
      ),
      ...(definition.config.budget === undefined ? {} : { budget: definition.config.budget }),
      ...(definition.config.providerOptions === undefined
        ? {}
        : { providerOptions: definition.config.providerOptions }),
    });

    return Object.freeze({
      runtimeId: definition.runtimeId,
      workerId: definition.workerId,
      generation: definition.generation,
      principalId: definition.principalId,
      attempt: definition.attempt,
      config,
    });
  }
}
