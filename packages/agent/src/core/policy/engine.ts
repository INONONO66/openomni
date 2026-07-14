import { PolicyEngine as GenericPolicyEngine } from "@openomni/policy";
import type { PolicyEngineConfig } from "@openomni/policy";
import { agentPolicyCompatibility } from "./compatibility";
import type { PolicyContext, PolicyEngineRegistration } from "./types";

export const PolicyEngine = {
  create(options: PolicyEngineConfig = {}) {
    const engine = GenericPolicyEngine.create<PolicyContext>(options, agentPolicyCompatibility);
    return {
      register(registration: PolicyEngineRegistration): void {
        engine.register(registration);
      },
      dispatch: engine.dispatch,
      dispatchPoint: engine.dispatchPoint,
    };
  },
} as const;
