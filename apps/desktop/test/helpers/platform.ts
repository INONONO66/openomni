import { bindStorePlatform } from "../../src/renderer/state/store";
import type { RendererPlatform } from "../../src/renderer/platform";

/** Fixed injected clock (#1245): renderer tests assert exact times, never timing luck. */
export const TEST_NOW = 1_700_000_000_000;

let minted = 0;

/** Deterministic injected entropy (#1245): each id is `uuid-<n>` in mint order. */
export function testId(): string {
  minted += 1;
  return `uuid-${minted}`;
}

export const testPlatform: RendererPlatform = {
  now: () => TEST_NOW,
  id: testId,
};

// Importing this module is the test-side bootstrap: the store mints through
// the deterministic platform from the first line of every suite that uses it.
bindStorePlatform(testPlatform);
