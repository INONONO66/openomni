import { ChatAgent } from "@openomni/agent";
import type { SubagentToolOptions, ChatAgentConfig } from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import type { Guardrail, WorkerBootstrap } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { SubagentRuntime } from "../../../../subagent/runtime.js";
import { resolveToolSelection } from "../../catalog.js";
import type { CatalogEntry } from "../../catalog.js";

type SubagentRuntimeInterface = SubagentToolOptions["subagentRuntime"];
type RuntimeAgentDefinition = WorkerBootstrap.RuntimeAgentDefinition;

// Simple in-process shim: creates a fresh ChatAgent per call without tool inheritance.
export function createSubagentRuntime(): SubagentRuntimeInterface {
  return {
    async spawn(config) {
      const agent = ChatAgent.create({
        model: config.model,
        systemPrompt: config.systemPrompt,
        middleware: config.middleware,
      });
      const result = await agent.run({
        messages: [{ role: "user", content: config.prompt }],
      });
      return {
        sessionId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        output: result.text,
      };
    },
    async send(config) {
      // stateless for now — create a fresh agent per send (session persistence is future work)
      const agent = ChatAgent.create({
        model: config.model,
        systemPrompt: config.systemPrompt,
        middleware: config.middleware,
      });
      const result = await agent.run({
        messages: [{ role: "user", content: config.prompt }],
      });
      return {
        sessionId: config.sessionId,
        runId: crypto.randomUUID(),
        output: result.text,
      };
    },
  };
}

function intersectPermissions(
  parent: Guardrail.ToolPermission | undefined,
  child: Guardrail.ToolPermission | undefined,
): Guardrail.ToolPermission | undefined {
  if (!parent && !child) return undefined;
  if (!parent) return child;
  if (!child) return parent;
  return {
    denylist: [...(parent.denylist ?? []), ...(child.denylist ?? [])],
    allowlist: child.allowlist ?? parent.allowlist,
    requireApproval: child.requireApproval ?? parent.requireApproval,
    inputRules: [...(parent.inputRules ?? []), ...(child.inputRules ?? [])],
  };
}

type WorkerRuntimeConfig = {
  // Lazily resolved after createExecutionToolContext — filled before any tool call.
  toolsRef: { tools?: ChatAgentConfig["tools"]; toolExecutor?: ChatAgentConfig["toolExecutor"] };
  parentSessionId: string;
  parentPermissions?: Guardrail.ToolPermission;
  // Lazily resolved alongside toolsRef — used to compute depth-filtered child tool sets.
  catalogRef?: { catalog?: CatalogEntry[] };
  agentDefinitionsRef?: { definitions?: Map<string, RuntimeAgentDefinition> };
};

function resolveChildDefinition(
  cfg: WorkerRuntimeConfig,
  agentName: string | undefined,
): RuntimeAgentDefinition | undefined {
  if (!agentName) return undefined;
  return cfg.agentDefinitionsRef?.definitions?.get(agentName);
}

function resolveSessionAgentName(sessionId: string): string | undefined {
  const meta = Session.getWorkerMeta(sessionId);
  if (!meta) return undefined;
  try {
    return Subagent.ChildSessionMeta.parse(meta).agentName;
  } catch {
    return undefined;
  }
}

function resolveChildTools(
  cfg: WorkerRuntimeConfig,
  childDefinition: RuntimeAgentDefinition | undefined,
  depth: number,
): ChatAgentConfig["tools"] {
  if (!cfg.catalogRef?.catalog) {
    return cfg.toolsRef.tools;
  }

  const parentAllowed = cfg.toolsRef.tools
    ? new Set(cfg.toolsRef.tools.map((tool) => tool.name))
    : undefined;
  const filtered = resolveToolSelection(
    cfg.catalogRef.catalog,
    childDefinition?.tools ?? { all: true },
    parentAllowed,
    depth,
  );
  return filtered.map((entry) => entry.tool.spec);
}

export function createWorkerSubagentRuntime(cfg: WorkerRuntimeConfig): SubagentRuntimeInterface {
  return {
    async spawn(config) {
      const childDefinition = resolveChildDefinition(cfg, config.agentName);
      const permissions = intersectPermissions(cfg.parentPermissions, childDefinition?.permissions);
      const childTools = resolveChildTools(cfg, childDefinition, 1);

      const result = await SubagentRuntime.spawn({
        agentName: config.agentName,
        title: config.title,
        prompt: config.prompt,
        model: config.model,
        systemPrompt: config.systemPrompt,
        tools: childTools,
        toolExecutor: cfg.toolsRef.toolExecutor,
        parentSessionId: cfg.parentSessionId,
        permissions,
      });
      return { sessionId: result.sessionId, runId: result.runId, output: result.output };
    },
    async send(config) {
      const childDefinition = resolveChildDefinition(
        cfg,
        resolveSessionAgentName(config.sessionId),
      );
      const permissions = intersectPermissions(cfg.parentPermissions, childDefinition?.permissions);
      const depth = Session.get(config.sessionId)?.spawnDepth ?? 1;
      const result = await SubagentRuntime.send({
        sessionId: config.sessionId,
        prompt: config.prompt,
        model: config.model,
        systemPrompt: config.systemPrompt,
        tools: resolveChildTools(cfg, childDefinition, depth),
        toolExecutor: cfg.toolsRef.toolExecutor,
        permissions,
      });
      return { sessionId: result.sessionId, runId: result.runId, output: result.output };
    },
  };
}
