import { ChatAgent, AgentRegistry } from "@openomni/agent";
import type { SubagentToolOptions, ChatAgentConfig } from "@openomni/agent";
import type { Guardrail } from "@openomni/protocol";
import { SubagentRuntime } from "../../../../subagent/runtime.js";
import { resolveToolSelection } from "../../catalog.js";
import type { CatalogEntry } from "../../catalog.js";

type SubagentRuntimeInterface = SubagentToolOptions["subagentRuntime"];

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
};

export function createWorkerSubagentRuntime(cfg: WorkerRuntimeConfig): SubagentRuntimeInterface {
  return {
    async spawn(config) {
      const childDef = AgentRegistry.get(config.agentName);
      const permissions = intersectPermissions(cfg.parentPermissions, childDef?.permissions);

      let childTools = cfg.toolsRef.tools;
      if (cfg.catalogRef?.catalog) {
        const parentAllowed = cfg.toolsRef.tools
          ? new Set(cfg.toolsRef.tools.map((t) => t.name))
          : undefined;
        const filtered = resolveToolSelection(
          cfg.catalogRef.catalog,
          { all: true },
          parentAllowed,
          1,
        );
        childTools = filtered.map((e) => e.tool.spec);
      }

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
      const permissions = cfg.parentPermissions;
      const result = await SubagentRuntime.send({
        sessionId: config.sessionId,
        prompt: config.prompt,
        model: config.model,
        systemPrompt: config.systemPrompt,
        tools: cfg.toolsRef.tools,
        toolExecutor: cfg.toolsRef.toolExecutor,
        permissions,
      });
      return { sessionId: result.sessionId, runId: result.runId, output: result.output };
    },
  };
}
