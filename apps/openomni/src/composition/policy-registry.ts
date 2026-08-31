/**
 * Policy registry — registration ownership for agent-run policy middleware.
 *
 * The registry owns which policies a Resident run receives and under what
 * class. `mandatory` names are declared up front, at the composition root:
 * a run may not proceed without every one of them, so losing a mandatory
 * registration suspends the dependent capability fail-closed (`middlewareFor`
 * throws `MissingMandatoryPolicyError`) instead of silently running with less
 * protection. Optional policies shape runs while present and are simply
 * absent when unregistered.
 *
 * Policies are factories, not instances: middleware is constructed per run
 * because it binds run-scoped state (the observation's event channel).
 *
 * Boundary, deliberately narrow: this registry supplies run middleware only.
 * Middleware may tighten a run (compaction, elision, refusal) but never
 * admits anything — admission verdicts stay with the perimeter gateway and
 * the delegation kernel, exactly one judgment seat each. Nothing registered
 * here can widen authority.
 */

import type { ChatAgentConfig } from "@openomni/agent";

type Middleware = NonNullable<ChatAgentConfig["middleware"]>[number];

/** Run-scoped state a policy factory may bind. */
interface PolicyRunContext {
  readonly events: ChatAgentConfig["events"];
}

interface PolicyRegistration {
  readonly name: string;
  readonly class: "mandatory" | "optional";
  /**
   * Removes this registration from the registry if it is still the current
   * one for its name. Disposing a replaced registration never evicts its
   * successor.
   */
  dispose(): void;
}

export interface PolicyRegistry {
  /** Registers a policy factory, replacing the previous holder of the name. */
  register(name: string, factory: (run: PolicyRunContext) => Middleware): PolicyRegistration;
  /**
   * Builds the middleware for one run, in registration order. Throws
   * `MissingMandatoryPolicyError` when any declared-mandatory name has no
   * active registration — the run must not proceed with less than the
   * declared floor.
   */
  middlewareFor(run: PolicyRunContext): Middleware[];
}

export class MissingMandatoryPolicyError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`mandatory policy missing: ${missing.join(", ")} — run suspended fail-closed`);
    this.name = "MissingMandatoryPolicyError";
    this.missing = missing;
  }
}

export function createPolicyRegistry(options: {
  /** Names a run may never proceed without. Declared once, at composition. */
  readonly mandatory: readonly string[];
}): PolicyRegistry {
  const mandatory = new Set(options.mandatory);
  const table = new Map<string, { factory: (run: PolicyRunContext) => Middleware }>();

  return {
    register(name, factory) {
      const entry = { factory };
      table.set(name, entry);
      return {
        name,
        class: mandatory.has(name) ? "mandatory" : "optional",
        dispose() {
          if (table.get(name) === entry) {
            table.delete(name);
          }
        },
      };
    },

    middlewareFor(run) {
      const missing = [...mandatory].filter((name) => !table.has(name));
      if (missing.length > 0) {
        throw new MissingMandatoryPolicyError(missing);
      }
      return [...table.values()].map((entry) => entry.factory(run));
    },
  };
}
