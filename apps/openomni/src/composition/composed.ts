import { Bundle } from "@openomni/agent";
import { Context } from "effect";

/**
 * The composed-generation seam (#1255 P3): boot runs `config → manifest →
 * compose → runtime` and hands the result here; everything downstream
 * (generation Layers, ingress materialization, resident faces, provisioning
 * recompose in P4) reads the CURRENT composition through this one service.
 * The holder is late-swappable: `provision{bundle_enable|bundle_disable}`
 * recomposes from empty state and replaces `current()`'s value — sessions
 * adopt at their next turn start (core rotation, #1255 S3).
 */
export interface ComposedContext {
  /** The manifest the generation was composed from (rollback = recompose with it). */
  readonly manifest: Bundle.ManifestDefinition;
  /** The compiled generation: one journaled table set, never patched in place. */
  readonly generation: Bundle.Generation;
}

/** The swappable composition cell: `swap` is `provision{bundle_*}`'s recompose commit (#1255 P4). */
export interface ComposedHolder {
  readonly current: () => ComposedContext;
  readonly swap: (next: ComposedContext) => void;
}

export function composedHolderOf(initial: ComposedContext): ComposedHolder {
  let current = initial;
  return {
    current: () => current,
    swap: (next) => {
      current = next;
    },
  };
}

export class ComposedGeneration extends Context.Service<
  ComposedGeneration,
  ComposedHolder
>()("@openomni/openomni/ComposedGeneration") {}

const EMPTY_MANIFEST = Bundle.Manifest.define({ capabilities: [], bundles: [], off: [] });

/**
 * The empty composition an injected runtime starts from: no capabilities, no
 * bundles. Its generation is valid (core points only) so every consumer reads
 * one honest table set instead of special-casing "not composed yet".
 */
export function emptyComposition(): ComposedContext {
  return { manifest: EMPTY_MANIFEST, generation: Bundle.composeSync(EMPTY_MANIFEST) };
}
