import * as Adopt from "./adopt";
import * as AppendCore from "./append";
import * as Read from "./read";

/** Hash-chained facts with atomic revision comparison and validated evidence reads. */
export namespace Ledger {
  export const append = AppendCore.append;
  export const adoptStream = Adopt.adoptStream;
  export const headFact = Read.headFact;
  export const factsByType = Read.factsByType;
}
