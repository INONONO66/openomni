import { ChatAgent, createToolPermissionPolicy } from "@openomni/agent";
import type { SubagentToolOptions, ChatAgentConfig } from "@openomni/agent";
import { type Policy, Subagent } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { SubagentRuntime } from "../../../../subagent/runtime.js";
import { buildWorkerMiddleware, resolvePolicyPlanToolPermission } from "../../../middleware.js";
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
        signal: config.signal,
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
        signal: config.signal,
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

export function intersectPermissions(
  parent: Policy.Permission | undefined,
  child: Policy.Permission | undefined,
): Policy.Permission | undefined {
  if (!parent && !child) return undefined;
  if (!parent) return child;
  if (!child) return parent;
  return {
    action: child.action,
    denylist: [...(parent.denylist ?? []), ...(child.denylist ?? [])],
    denyLabels: [...(parent.denyLabels ?? []), ...(child.denyLabels ?? [])],
    allowlist: intersectAllowPatterns(parent.allowlist, child.allowlist),
    allowLabels: intersectAllowPatterns(parent.allowLabels, child.allowLabels),
    requireApproval: [...(parent.requireApproval ?? []), ...(child.requireApproval ?? [])],
    requireApprovalLabels: [
      ...(parent.requireApprovalLabels ?? []),
      ...(child.requireApprovalLabels ?? []),
    ],
    inputRules: [...(parent.inputRules ?? []), ...(child.inputRules ?? [])],
  };
}

function intersectAllowPatterns(
  parent: string[] | undefined,
  child: string[] | undefined,
): string[] | undefined {
  if (!parent) return child;
  if (!child) return parent;
  if (parent.includes("*")) return child;
  if (child.includes("*")) return parent;
  const parentSet = new Set(parent);
  return child.filter((pattern) => parentSet.has(pattern));
}

export type WorkerRuntimeConfig = {
  // Lazily resolved after createExecutionToolContext — filled before any tool call.
  toolsRef: { tools?: ChatAgentConfig["tools"]; toolExecutor?: ChatAgentConfig["toolExecutor"] };
  parentSessionId: string;
  parentPermissions?: Policy.Permission;
  // Lazily resolved alongside toolsRef — used to compute depth-filtered child tool sets.
  catalogRef?: { catalog?: CatalogEntry[] };
  agentDefinitionsRef?: { definitions?: Map<string, RuntimeAgentDefinition> };
  resolveAuth?: (provider: string) => ChatAgentConfig["auth"];
  allowAuthFallback?: ChatAgentConfig["allowAuthFallback"];
};

type WorkerChildRuntimeConfig = {
  childDefinition?: RuntimeAgentDefinition;
  tools: ChatAgentConfig["tools"];
  toolExecutor: ChatAgentConfig["toolExecutor"];
  systemPrompt?: string;
  permissions?: Policy.Permission;
  admissionPermissions?: Policy.Permission;
  middleware: ChatAgentConfig["middleware"];
  childMiddleware: ChatAgentConfig["middleware"];
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

function buildChildRuntimeMiddleware(
  childDefinition: RuntimeAgentDefinition | undefined,
  childPermissions: Policy.Permission | undefined,
  parentPermissions: Policy.Permission | undefined,
): ChatAgentConfig["middleware"] {
  const middleware: ChatAgentConfig["middleware"] = [];
  if (parentPermissions && childDefinition?.policyPlan) {
    // Legacy parent permissions remain an ancestor runtime guard even when the
    // child plan owns the child-scoped permission config. Parent policy plans
    // stay parent-scoped and are not copied into child runtime middleware.
    middleware.push(createToolPermissionPolicy({ permission: parentPermissions }));
  }
  if (childDefinition?.policyPlan) {
    middleware.push(
      ...buildWorkerMiddleware({
        policyPlan: childDefinition.policyPlan,
        permissions: childPermissions,
        includeLifecycle: false,
        includeIdle: false,
      }),
    );
  }
  return middleware.length > 0 ? middleware : undefined;
}

export function buildWorkerChildRuntimeConfig(
  cfg: WorkerRuntimeConfig,
  input: {
    agentName?: string;
    childDefinition?: RuntimeAgentDefinition;
    depth: number;
    middleware?: ChatAgentConfig["middleware"];
  },
): WorkerChildRuntimeConfig {
  const childDefinition = input.childDefinition ?? resolveChildDefinition(cfg, input.agentName);
  const childPermissions = childDefinition?.permissions;
  const childPolicyPlanPermissions = resolvePolicyPlanToolPermission(
    childDefinition?.policyPlan,
    childPermissions,
  );
  const effectivePermissions = intersectPermissions(
    cfg.parentPermissions,
    childDefinition?.policyPlan ? childPolicyPlanPermissions : childPermissions,
  );
  const permissions = childDefinition?.policyPlan ? undefined : effectivePermissions;
  return {
    ...(childDefinition ? { childDefinition } : {}),
    tools: resolveChildTools(cfg, childDefinition, input.depth),
    toolExecutor: cfg.toolsRef.toolExecutor,
    systemPrompt: childDefinition?.systemPrompt,
    permissions,
    admissionPermissions: effectivePermissions,
    middleware: input.middleware,
    childMiddleware: buildChildRuntimeMiddleware(
      childDefinition,
      childPermissions,
      cfg.parentPermissions,
    ),
  };
}

export function createWorkerSubagentRuntime(cfg: WorkerRuntimeConfig): SubagentRuntimeInterface {
  return {
    async spawn(config) {
      const childRuntime = buildWorkerChildRuntimeConfig(cfg, {
        agentName: config.agentName,
        depth: 1,
        middleware: config.middleware,
      });

      const result = await SubagentRuntime.spawn({
        agentName: config.agentName,
        title: config.title,
        prompt: config.prompt,
        model: config.model,
        auth: cfg.resolveAuth?.(config.model.provider),
        allowAuthFallback: cfg.allowAuthFallback,
        // Worker bootstrap definitions are the source of truth; config is only
        // a compatibility fallback for runtimes without bootstrap context.
        systemPrompt: childRuntime.systemPrompt ?? config.systemPrompt,
        tools: childRuntime.tools,
        toolExecutor: childRuntime.toolExecutor,
        parentSessionId: cfg.parentSessionId,
        permissions: childRuntime.permissions,
        admissionPermissions: childRuntime.admissionPermissions,
        middleware: childRuntime.middleware,
        childMiddleware: childRuntime.childMiddleware,
        signal: config.signal,
      });
      return { sessionId: result.sessionId, runId: result.runId, output: result.output };
    },
    async send(config) {
      const childDefinition = resolveChildDefinition(
        cfg,
        resolveSessionAgentName(config.sessionId),
      );
      const depth = Session.get(config.sessionId)?.spawnDepth ?? 1;
      const childRuntime = buildWorkerChildRuntimeConfig(cfg, {
        childDefinition,
        depth,
        middleware: config.middleware,
      });
      const result = await SubagentRuntime.send({
        sessionId: config.sessionId,
        prompt: config.prompt,
        model: config.model,
        auth: cfg.resolveAuth?.(config.model.provider),
        allowAuthFallback: cfg.allowAuthFallback,
        // Worker bootstrap definitions are the source of truth; config is only
        // a compatibility fallback for runtimes without bootstrap context.
        systemPrompt: childRuntime.systemPrompt ?? config.systemPrompt,
        tools: childRuntime.tools,
        toolExecutor: childRuntime.toolExecutor,
        permissions: childRuntime.permissions,
        admissionPermissions: childRuntime.admissionPermissions,
        middleware: childRuntime.middleware,
        childMiddleware: childRuntime.childMiddleware,
        signal: config.signal,
      });
      return { sessionId: result.sessionId, runId: result.runId, output: result.output };
    },
  };
}
