/**
 * Resolves once `promise` settles, regardless of outcome. Ownership tracking
 * (retained runners, tool waves, close grace) cares about settlement only; the
 * value or rejection reason is consumed by whoever awaits the original promise.
 */
export function settled<T>(promise: Promise<T>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}
