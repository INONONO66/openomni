/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { runVerifierRegistryDriver } from "../harness/verifier-registry-driver-api";

describe("verifier registry benchmark evidence", () => {
  test("derives every benchmark axis from executable fixtures", () => {
    const execution = runVerifierRegistryDriver(["--self-test"]);
    expect(execution.exitCode).toBe(0);
    const receipt = parseObject(execution.stdout);
    const benchmark = parseObject(receipt.benchmark);
    const taxonomy = parseObject(benchmark.taxonomy);
    const toolValidity = parseObject(benchmark.toolValidity);
    const surface = parseObject(benchmark.surface);

    expect(taxonomy).toMatchObject({
      fixtureCount: 23,
      assertedTruePositive: 7,
      assertedFalsePositive: 0,
      assertedFalseNegative: 0,
      assertedPrecision: 1,
      assertedRecall: 1,
    });
    expect(toolValidity).toEqual({
      astValid: true,
      schemaValid: true,
      nativeRoundTripValid: true,
    });
    expect(typeof surface.toolCount).toBe("number");
    expect(typeof surface.fieldCount).toBe("number");
    expect(typeof surface.tokenCount).toBe("number");
    expect(Number(surface.toolCount)).toBeGreaterThan(0);
    expect(Number(surface.fieldCount)).toBeGreaterThan(0);
    expect(Number(surface.tokenCount)).toBeGreaterThan(0);
    expect(receipt.exposedActions).toEqual([]);
    expect(receipt.exposedCapabilities).toEqual([]);
  });
});

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}
