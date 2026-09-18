import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { Storage } from "./storage";

/** Narrow first-writer-wins port on the shared storage transaction boundary. */
export namespace DecisionFacts {
  export type Port = ProtocolStorage.DecisionFactSubAdapter;

  /** One perimeter admission unit, including its injected durable deadline write. */
  export function transaction<T>(operation: () => T): T {
    return Storage.get().transaction(operation);
  }

  export function port(): Port | undefined {
    return Storage.get().decisionFacts;
  }
}
