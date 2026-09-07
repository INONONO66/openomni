import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { Storage } from "./storage";

/**
 * Scoped decision-append port (#707 S8 review fix): the gateway router
 * records `route.decided` through THIS pair — `append` + `headFact` (the
 * #510 C3 record-before-act write and its replay read) — never through the
 * master `Storage` entry, whose adapter reaches every brain surface
 * (canonical sessions and action history). Exposing exactly the two
 * record methods, plus an admission transaction boundary, keeps gateway-design
 * §6's "named perimeter surfaces plus a scoped append port" and lets its pin drop
 * `Storage` from the router allowlist.
 *
 * Returns `undefined` when the active adapter lacks the ledger sub-adapter
 * so each caller keeps its own fail-closed typed error (a routing decision
 * that cannot be recorded must not act).
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
