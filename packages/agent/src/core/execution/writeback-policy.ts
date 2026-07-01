import { PolicyDecision } from "@openomni/protocol";
import { effectOf } from "./policy-effects";
import type { PolicyEngineInstance } from "../policy";
import type { ChatAgentConfig } from "../types";
import { buildLifecyclePolicyContext } from "./lifecycle-context";
import type { RunState } from "./run-state";

export async function dispatchWritebackCommit(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  output: string,
): Promise<string> {
  const decision = await engine.dispatch(
    "writeback.commit",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
      toolInput: { output },
    }),
  );

  if (PolicyDecision.isBlocking(decision)) {
    throw new Error(PolicyDecision.reason(decision, "writeback.commit policy denied"));
  }

  const suppress = effectOf(decision, "writeback.suppress");
  if (suppress) throw new Error(suppress.reason ?? "writeback.commit policy suppressed output");
  return effectOf(decision, "writeback.rewrite")?.output ?? output;
}
