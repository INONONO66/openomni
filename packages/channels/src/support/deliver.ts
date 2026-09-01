import type { DedupeWindow } from "./dedupe";
import { newTraceId } from "./trace";

export interface DeliveryReceipt {
  externalMessageId?: string;
}

/**
 * Shared `deliver()` shell for the existing-agent delivery seam: report the
 * platform message id of the final chunk (the message a reply would
 * reference). Origin: the messaging kernel's deliver seam does not thread the
 * sender's trace yet (#215) — each delivery is its own causal chain. The
 * idempotency window is an additive capability only: the current server
 * composition calls this seam without a key, which intentionally retains
 * at-least-once behavior.
 */
export function deliverKeyed(
  window: DedupeWindow<DeliveryReceipt>,
  idempotencyKey: string | undefined,
  send: (traceId: string) => Promise<string | undefined>,
): Promise<DeliveryReceipt> {
  const attempt = async (): Promise<DeliveryReceipt> => {
    const traceId = newTraceId();
    const externalMessageId = await send(traceId);
    return externalMessageId === undefined ? {} : { externalMessageId };
  };
  return idempotencyKey === undefined ? attempt() : window.run(idempotencyKey, attempt);
}
