import type { UIMessage } from "ai";

/**
 * This product's message type: the AI SDK's `UIMessage`, with its three open
 * slots closed.
 *
 * The SDK leaves metadata, data parts, and tools as generics precisely so an
 * application can name them once and have every downstream surface — the chat
 * store, the transport, the adapter — agree on the same shape without a cast.
 * Closing them here is what lets the adapter read `part.input.command` instead
 * of interrogating an `unknown`, and it is the only file in the renderer that
 * needs to know what those slots are filled with.
 *
 * `@openomni/ui` imports NONE of this. The design system's transcript takes
 * strings and outcomes; the fact that they came from an SDK message is the
 * app's business and stops at `adapter.ts`.
 */

/**
 * What a turn cost, as the wire reports it: raw instants and counts.
 *
 * The design system's `TurnCost` is already-formatted text (`14:32`, `18s`)
 * because the transcript must not do arithmetic on a clock. The two are
 * deliberately different types with the adapter between them — a formatted
 * string is what the surface needs, and an epoch millisecond is the only thing
 * a model server can honestly send.
 *
 * `tokens` has no row in the transcript today. It is carried because the turn
 * is the only place the count is still attributable, and dropping it at the
 * boundary would mean re-deriving it from a stream that has already closed.
 */
export interface TurnMetadata {
  /** Wall clock of the turn's first token, epoch ms. */
  readonly startedAt?: number;
  /** How long the turn took, in ms. */
  readonly elapsedMs?: number;
  readonly tokens?: { readonly in: number; readonly out: number };
}

/**
 * The tools this surface knows the shape of at development time.
 *
 * Static tools buy exhaustiveness: `tool-bash` parts arrive with a typed
 * `input`, so the adapter reads the command directly. Anything the gateway
 * grows later arrives as a `dynamic-tool` part with an `unknown` input — still
 * rendered, still approvable, just parsed at that one boundary instead of
 * trusted. Both paths are exercised by the adapter's tests.
 */
type OpenOmniTools = {
  bash: {
    input: { readonly command: string };
    output: { readonly stdout: string };
  };
};

/**
 * A ledger boundary — a compaction or a resume — streamed as a data part.
 *
 * It is a data part rather than a tool call because nothing executed: it is a
 * fact about the transcript itself, and the transcript is the only surface that
 * has a row for it.
 */
type OpenOmniDataParts = {
  epoch: { readonly label: string };
};

export type OpenOmniUIMessage = UIMessage<TurnMetadata, OpenOmniDataParts, OpenOmniTools>;
