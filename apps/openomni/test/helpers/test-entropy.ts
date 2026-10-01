/** Deterministic injected id entropy for fixtures (#1245): no ambient crypto in tests. */
export function testIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** Injected channel-runtime seams for profile fixtures (#1245). */
export function testChannelDeps(prefix = "channel") {
  return {
    publish: () => undefined,
    now: () => 1000,
    id: testIds(prefix),
    random: () => 0.5,
  };
}
