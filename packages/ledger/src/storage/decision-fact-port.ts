import type { Storage as ProtocolStorage } from "@openomni/protocol";

/** Narrow first-writer-wins port on one store handle's transaction boundary. */
export namespace DecisionFacts {
  export type Port = ProtocolStorage.DecisionFactSubAdapter;

  export interface Source {
    readonly decisionFacts?: Port;
    transaction<T>(operation: () => T): T;
  }
}

/**
 * Handle-scoped decision-fact port (W5.2 F1): the perimeter injects the store
 * handle whose transaction boundary its admission unit runs in.
 */
export function createDecisionFactPort(source: DecisionFacts.Source): {
  transaction<T>(operation: () => T): T;
  port(): DecisionFacts.Port | undefined;
} {
  return {
    transaction: (operation) => source.transaction(operation),
    port: () => source.decisionFacts,
  };
}
