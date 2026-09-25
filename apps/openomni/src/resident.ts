import { ObservationSink } from "@openomni/agent";
import { Effect } from "effect";
import {
  createSessionChatRunner,
  createTurnDispatcher,
  failureFacts,
  newTraceId,
  sessionTool,
  ToolRefused,
  type ChatAgentConfig,
  type SessionRunner,
  type SessionRuntime,
} from "@openomni/agent";
import type { AnyToolDefinition, LedgerSession, Model, Tool } from "@openomni/protocol";
import { chatProviderConfig } from "./composition/chat-provider";
import { messageMaterialization } from "./composition/message-session";
import { classifyTurnFailure } from "./observation/llm-failure";
import { observeComponent } from "./observation/component";
import { buildAgentPrompt } from "./prompt/build";
import { RESIDENT_PRESET, WORKER_PRESET } from "./prompt/roles";
import { toolCatalogLayer, type GenerationDefinitions } from "./composition/generation-layers";
import { catalogDefinitions, type ToolPorts } from "./tools/core/catalog";

export function refuseEvidenceOnly(call: Tool.Call): Tool.Result & { readonly errorKind: "precondition_failed" } {
  const refusal = new ToolRefused(call.tool, "evidence-only message");
  return {
    id: call.id,
    toolCallId: call.id,
    toolName: call.tool,
    output: refusal.message,
    errorKind: refusal.errorKind,
    isError: true,
    settlement: "settled",
  };
}

export interface ResidentOptions {
  readonly model: Model.Ref;
  readonly modelFallbacks?: readonly Model.Ref[];
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
  readonly bundles?: readonly string[];
  readonly compaction?: Effect.Effect<NonNullable<ChatAgentConfig["compaction"]>, never, import("@openomni/llm").Llm | ObservationSink>;
  readonly tools: ToolPorts;
  readonly toolDefinitions?: readonly AnyToolDefinition[];
  readonly sessionRuntime: SessionRuntime;
}

/** Resident and worker use the same session-owned runner and dispatcher. */
export function createResident(options: ResidentOptions) {
  const ports = options.tools;
  const catalog = catalogDefinitions(ports);
  const definitionsFor = (role: LedgerSession.Role) => [
    ...catalog.filter((tool) => tool.visibility.model.includes(role) || tool.visibility.cell.includes(role)),
    ...(options.toolDefinitions ?? []),
  ];
  const definitions: GenerationDefinitions = {
    resident: definitionsFor("resident"),
    worker: definitionsFor("worker"),
    catalogLayer: (select) => toolCatalogLayer(ports, (tools) => select([...tools, ...(options.toolDefinitions ?? [])])),
  };
  const runnerFor =
    (row: LedgerSession.Row): SessionRunner =>
    (input) => Effect.gen(function* () {
      const dispatcher = yield* createTurnDispatcher(input, options.sessionRuntime);
      const observations = yield* ObservationSink;
      const compaction = options.compaction === undefined ? undefined : yield* options.compaction;
      const traceId = newTraceId();
      const observation = observeComponent({
        traceId,
        sessionId: input.sessionId,
        runId: input.resultId,
        actorId: row.role,
        agentName: row.role,
        componentId: `${row.role}.agent`,
        componentGeneration: input.resumeCount + 1,
        pluginName: `builtin.${row.role}`,
      }, observations);
      const evidenceOnly = input.authority === "evidence_only";
      const offered = new Set(input.tools.map((tool) => tool.name));
      const tools = evidenceOnly ? [] : dispatcher.specs.filter((tool) => offered.has(tool.name));
      const runner = createSessionChatRunner({
        prepare: () => Effect.succeed({
          config: {
            executor: dispatcher.executor,
            systemPrompt: input.system,
            tools,
            toolChoice: tools.length === 0 ? "none" : "auto",
            toolWave: (calls, signal) =>
              evidenceOnly
                ? Effect.succeed(calls.map(refuseEvidenceOnly))
                : dispatcher.executeWave(calls, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    signal,
                  }),
            model: options.model,
            ...(options.modelFallbacks === undefined
              ? {}
              : { modelFallbacks: [...options.modelFallbacks] }),
            ...(compaction === undefined ? {} : { compaction }),
            ...chatProviderConfig(options),
          },
          traceContext: {
            traceId,
            sessionId: input.sessionId,
            runId: input.resultId,
            agentName: row.role,
          },
          around: (operation) => observation.run(operation),
        }),
        reportError: (error) =>
          failureFacts(error)?.llm === true ? classifyTurnFailure(error).text : undefined,
      });
      return yield* runner(input).pipe(Effect.provideService(ObservationSink, { ...observations, publish: observation.events.publish }));
    });
  return {
    runnerFor,
    definitions,
    materialize(id: string, parentId: string | null, role: LedgerSession.Role, runner: string) {
      if (!["resident", "worker", "native", "process"].includes(runner)) {
        throw new Error(`runner is not registered: ${runner}`);
      }
      return messageMaterialization({
        id,
        parentId,
        role,
        runner,
        tools: definitions[role].map(sessionTool),
        bundles: options.bundles ?? [],
        preset: buildAgentPrompt(role === "resident" ? RESIDENT_PRESET : WORKER_PRESET),
        at: ports.clock(),
      });
    },
  };
}
