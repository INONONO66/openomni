import type { CompletionRequestReservation } from "./completion-admission.js";

/** Pure structural fold for receipt heads separated by durable reservations. */
export function hasContiguousReservationBridge(
  reservations: readonly Pick<CompletionRequestReservation, "requestId" | "recordedHead">[],
  requestId: string,
  fromHead: number,
  toHead: number,
): boolean {
  const expected = toHead - fromHead - 1;
  if (expected <= 0) return false;
  const bridging = reservations.filter(
    (reservation) =>
      reservation.requestId === requestId &&
      reservation.recordedHead > fromHead &&
      reservation.recordedHead < toHead,
  );
  if (bridging.length !== expected) return false;
  const heads = new Set(bridging.map(({ recordedHead }) => recordedHead));
  if (heads.size !== expected) return false;
  for (let head = fromHead + 1; head < toHead; head += 1) {
    if (!heads.has(head)) return false;
  }
  return true;
}
