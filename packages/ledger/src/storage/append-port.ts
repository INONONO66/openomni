import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { Storage } from "./storage";

/**
 * Narrow append/headFact port with a shared transaction boundary.
 * An absent ledger returns undefined; callers must fail closed when recording fails.
 */
export namespace LedgerAppend {
  export type Port = Pick<ProtocolStorage.LedgerSubAdapter, "append" | "headFact">;

  /** One perimeter admission unit, including its injected durable deadline write. */
  export function transaction<T>(operation: () => T): T {
    return Storage.get().transaction(operation);
  }

  export function port(): Port | undefined {
    return Storage.get().ledger;
  }
}
