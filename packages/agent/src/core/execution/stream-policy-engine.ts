import { PolicyEngine } from "../policy";
import type { PolicyEngineInstance } from "../policy";
import type { ChatAgentConfig } from "../types";
import { emitIgnoredPolicyConfigWarning } from "./stream-events";
import type { StreamAgentBase } from "./stream-state";

export function buildPolicyEngine(
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): PolicyEngineInstance {
  publishIgnoredPolicyConfigWarnings(config, agentBase);
  const engine = PolicyEngine.create({
    traceContext: {
      traceId: agentBase.traceId,
      ...(agentBase.sessionId !== "" && { sessionId: agentBase.sessionId }),
      ...(agentBase.runId !== undefined && { runId: agentBase.runId }),
    },
  });
  for (const reg of config.middleware ?? []) {
    engine.register(reg);
  }
  return engine;
}

function publishIgnoredPolicyConfigWarnings(
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): void {
  publishIgnoredPolicyConfigWarning(config, agentBase, {
    field: "permissions",
    replacement: "createToolPermissionPolicy()",
    middlewareName: "builtin:tool-permission",
  });
  publishIgnoredPolicyConfigWarning(config, agentBase, {
    field: "compaction",
    replacement: "createCompactionPolicy()",
    middlewareName: "builtin:compaction",
  });
}

function publishIgnoredPolicyConfigWarning(
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  options: {
    readonly field: "permissions" | "compaction";
    readonly replacement: string;
    readonly middlewareName: string;
  },
): void {
  if (config[options.field] === undefined) return;
  const replacementMiddlewarePresent = config.middleware?.some(
    (registration) => registration.name === options.middlewareName,
  );

  emitIgnoredPolicyConfigWarning(agentBase, {
    ...options,
    replacementMiddlewarePresent: replacementMiddlewarePresent ?? false,
  });
}
