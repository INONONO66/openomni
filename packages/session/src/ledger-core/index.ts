import * as Adopt from "./adopt";
import * as AppendCore from "./append";
import * as Chain from "./chain";
import * as Read from "./read";

/**
 * #510 Phase A append core. No production writer is cut over yet — later
 * #510 phases route every decision-class family through `Ledger.append`
 * (no record, no action) and freeze/archive/upcast the legacy writers.
 * The protocol-side types live in `LedgerAppend` (@openomni/protocol) until
 * the #499 `Ledger` namespace convergence.
 */
export namespace Ledger {
  export const append = AppendCore.append;
  export const adoptStream = Adopt.adoptStream;
  export const headFact = Read.headFact;
  export const factsByType = Read.factsByType;
  export const verifyTail = Chain.verifyTail;
}
