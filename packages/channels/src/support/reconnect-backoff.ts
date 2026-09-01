/**
 * Shared socket reconnect schedule (discord gateway, slack Socket Mode):
 * exponential from 1s, capped at 60s, with up to 1s of jitter so multiple
 * surfaces never thundering-herd a platform after one network blip.
 * Re-extracted from discord/gateway.ts once it gained a second importer
 * (the #453 sub-30-LOC rule applies to single-importer fragments only).
 */
const MAX_BACKOFF_MS = 60_000;

export function calculateBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS) + Math.random() * 1000;
}
