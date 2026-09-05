import { describe, expect, it } from "bun:test";
import { resolveCompactionGeometry } from "../../../src/compaction/geometry";

describe("turn preparation compaction geometry", () => {
  it("arms the model below the compaction threshold", () => {
    const geometry = resolveCompactionGeometry({ contextWindowTokens: 200_000 });
    expect(geometry.thresholdTokens).toBe(140_000);
    expect(geometry.prepareTokens).toBeLessThan(geometry.thresholdTokens);
  });

  it("moves the yield arm earlier after a high-yield compaction", () => {
    const geometry = resolveCompactionGeometry({
      contextWindowTokens: 200_000,
      previousYield: { savedTokens: 120_000, tokensBefore: 200_000 },
    });
    expect(Math.floor(geometry.thresholdTokens)).toBe(129_999);
  });

  it("keeps reserve, prepare, threshold, and grace ordered", () => {
    const geometry = resolveCompactionGeometry({ contextWindowTokens: 32_000 });
    expect(geometry.prepareTokens).toBeLessThan(geometry.thresholdTokens);
    expect(geometry.graceTokens).toBeGreaterThanOrEqual(geometry.thresholdTokens);
    expect(geometry.graceTokens).toBeLessThanOrEqual(32_000 - geometry.reserveTokens);
  });
});
