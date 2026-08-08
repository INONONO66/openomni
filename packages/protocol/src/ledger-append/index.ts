import * as Schema from "./schema.js";
import * as Streams from "./streams.js";

/**
 * Contract for the #510 serialized ledger append core:
 * `Ledger.append(event, expectedHead)` CAS input/outcome, the FULL/NORMAL
 * durability vocabulary, and the boot tail-verification chain-break fact.
 *
 * Folder/namespace is `ledger-append` (not `Ledger`) on purpose: the future
 * #499 protocol convergence owns the `Ledger` namespace; this module carries
 * only the append-boundary types so the rename lands without a clash.
 */
export namespace LedgerAppend {
  export const Durability = Schema.Durability;
  export type Durability = Schema.Durability;

  export const Input = Schema.Input;
  export type Input = Schema.Input;

  export const ExpectedHead = Schema.ExpectedHead;
  export type ExpectedHead = Schema.ExpectedHead;

  export const Outcome = Schema.Outcome;
  export type Outcome = Schema.Outcome;

  export const ChainBreakCode = Schema.ChainBreakCode;
  export type ChainBreakCode = Schema.ChainBreakCode;

  export const ChainBreak = Schema.ChainBreak;
  export type ChainBreak = Schema.ChainBreak;

  export const RecordedFact = Schema.RecordedFact;
  export type RecordedFact = Schema.RecordedFact;

  export const StreamRegistry = Streams.StreamRegistry;

  export const RouteDecided = Streams.RouteDecided;
  export type RouteDecided = Streams.RouteDecided;

  export const CommandAuthorized = Streams.CommandAuthorized;
  export type CommandAuthorized = Streams.CommandAuthorized;

  export const CommandDenied = Streams.CommandDenied;
  export type CommandDenied = Streams.CommandDenied;

  export const EffectIntended = Streams.EffectIntended;
  export type EffectIntended = Streams.EffectIntended;

  export const EffectConfirmed = Streams.EffectConfirmed;
  export type EffectConfirmed = Streams.EffectConfirmed;

  export const EffectFailed = Streams.EffectFailed;
  export type EffectFailed = Streams.EffectFailed;
}
