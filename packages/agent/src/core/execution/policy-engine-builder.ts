import { Bus } from "@openomni/session";
import { PolicyEngine } from "../policy";
import type { PolicyEngineInstance } from "../policy";
import type { ChatAgentConfig } from "../types";
import type { StreamAgentBase } from "./run-state";

export function buildPolicyEngine(
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): PolicyEngineInstance {
  const engine = PolicyEngine.create({
    traceContext: {
      traceId: agentBase.traceId,
      ...(agentBase.sessionId !== "" && { sessionId: agentBase.sessionId }),
      ...(agentBase.runId !== undefined && { runId: agentBase.runId }),
    },
    auditEmit: Bus.publish,
  });
  for (const reg of config.middleware ?? []) {
    engine.register(reg);
  }
  return engine;
}
