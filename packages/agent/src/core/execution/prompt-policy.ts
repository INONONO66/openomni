import { PolicyDecision } from "@openomni/protocol";
import type { Policy } from "@openomni/protocol";
import type { PolicyEngineInstance } from "../policy";
import { buildSystemPrompt } from "../prompt-builder";
import type { ChatAgentConfig } from "../types";
import { buildLifecyclePolicyContext } from "./lifecycle-context";
import type { RunState } from "./run-state";

export async function buildTurnSystemPrompt(
  state: RunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
): Promise<{ system?: string; blocked?: Policy.PolicyDecision }> {
  let system = buildSystemPrompt(config.systemPrompt, config.tools ?? []);
  const decision = await engine.dispatch(
    "context.prepare",
    buildLifecyclePolicyContext(state, config),
  );
  if (PolicyDecision.isBlocking(decision)) return { system, blocked: decision };

  for (const effect of decision.effects) {
    if (effect.type === "prompt.replace") {
      system = effect.prompt;
    } else if (effect.type === "prompt.append_context") {
      system = system
        ? `${system}

${effect.context}`
        : effect.context;
    } else if (effect.type === "prompt.inject_message") {
      system = system
        ? `${system}

${effect.message}`
        : effect.message;
    }
  }
  return { system };
}
