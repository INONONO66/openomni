import { describe, expect, it } from "bun:test";
import {
  baseThresholdRatioForWindow,
  resolveCompactionGeometry,
} from "../../src/compaction/geometry";

describe("compaction geometry", () => {
  it("tiers the base threshold by context window", () => {
    expect(
      [16_000, 32_000, 64_000, 128_000, 512_000, 1_000_000].map(baseThresholdRatioForWindow),
    ).toEqual([0.45, 0.5, 0.55, 0.6, 0.7, 0.8]);
  });

  it("moves the threshold from the previous compaction yield and clamps it", () => {
    expect(
      resolveCompactionGeometry({
        contextWindowTokens: 1_000_000,
        previousYield: { savedTokens: 600, tokensBefore: 1000 },
      }).thresholdRatio,
    ).toBe(0.75);
    expect(
      resolveCompactionGeometry({
        contextWindowTokens: 16_000,
        previousYield: { savedTokens: 50, tokensBefore: 1000 },
      }).thresholdRatio,
    ).toBe(0.5);
    expect(
      resolveCompactionGeometry({
        contextWindowTokens: 16_000,
        previousYield: { savedTokens: 900, tokensBefore: 1000 },
      }).thresholdRatio,
    ).toBe(0.4);
    expect(
      resolveCompactionGeometry({
        contextWindowTokens: 1_000_000,
        previousYield: { savedTokens: 1, tokensBefore: 1000 },
      }).thresholdRatio,
    ).toBe(0.85);
  });

  it("owns reserve, lead, prepare, and grace boundaries", () => {
    expect(resolveCompactionGeometry({ contextWindowTokens: 128_000 })).toMatchObject({
      thresholdTokens: 76_800,
      reserveTokens: 5120,
      leadTokens: 9600,
      prepareTokens: 67_200,
      graceTokens: 86_400,
    });
    expect(
      resolveCompactionGeometry({ contextWindowTokens: 1_000_000, reserveTokens: 60_000 })
        .reserveTokens,
    ).toBe(60_000);
    expect(resolveCompactionGeometry({ contextWindowTokens: 1_000_000 }).leadTokens).toBe(32_768);
  });
});
