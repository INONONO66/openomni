import type { LedgerAppend } from "@openomni/protocol";

/**
 * #492 effect driver port. A driver owns ONE effect kind and reaches the
 * external world idempotently under the effectId key. It is the ONLY seam
 * that touches the world; the service owns record-before-act, the store owns
 * durability, the driver owns the side effect and its probe.
 *
 * `execute` runs on a FRESH intent, receiving the transient request input
 * (never persisted — the ledger fact carries only the identity in
 * {@link EffectIntent}). `reconcile` runs on a crash-window intent with NO
 * input: it must determine the outcome by probing the world under the
 * effectId idempotency key (a HEAD/status lookup), never by re-issuing.
 *
 * Both return one {@link EffectExecution}:
 *   - confirmed / failed are DEFINITE outcomes (recorded as terminal facts);
 *   - unknown is a TRANSIENT runtime status — the driver cannot yet prove
 *     confirmed vs failed, so no terminal fact is recorded and the intent
 *     stays reconcilable. `exhausted` signals the driver has given up
 *     probing, which the reconciler escalates by Stakes rather than
 *     silently terminalizing.
 */
export type EffectIntent = LedgerAppend.EffectIntended;

export type EffectExecution =
  | Readonly<{ kind: "confirmed"; receipt?: string }>
  | Readonly<{ kind: "failed"; reason: string }>
  | Readonly<{ kind: "unknown"; reason?: string; exhausted?: boolean }>;

export interface EffectDriver {
  readonly kind: string;
  /**
   * The driver's replay declaration, stamped into the intent fact at record
   * time (senpi's per-record replay tag, adopted via #698): "safe" means a
   * replay/recovery consumer may re-execute this effect under its
   * idempotency key; "never" means recorded outcomes are read back only.
   * Required by type — every driver decides, none defaults.
   */
  readonly replay: "never" | "safe";
  execute(intent: EffectIntent, input: unknown): Promise<EffectExecution> | EffectExecution;
  reconcile(intent: EffectIntent): Promise<EffectExecution> | EffectExecution;
}
