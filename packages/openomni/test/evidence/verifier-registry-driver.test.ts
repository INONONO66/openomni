import { describe, expect, test } from "bun:test";
import {
  type VerifierRegistryDriverScenario,
  runVerifierRegistryDriver,
} from "../harness/verifier-registry-driver-api";
import { VerifierRegistryDriverScenarios } from "../harness/verifier-registry-driver-contract";

describe("VerifierRegistry driver", () => {
  test("publishes strict machine-readable CLI scenario and self-test receipts", () => {
    const expected = {
      "valid-native-round-trip": ["valid_native_round_trip", "verification_result", "verified"],
      "malformed-schema": ["malformed_schema", "verification_error", "malformed_input"],
      "known-bad-predicate": ["known_bad_refuted", "verification_result", "refuted"],
      "prohibited-capability": [
        "prohibited_capability",
        "verification_error",
        "prohibited_capability",
      ],
      "forbidden-action": ["forbidden_action", "verification_error", "forbidden_action"],
    } as const satisfies Record<VerifierRegistryDriverScenario, readonly [string, string, string]>;
    expect(Object.keys(expected)).toEqual([...VerifierRegistryDriverScenarios]);
    for (const scenario of Object.keys(expected) as VerifierRegistryDriverScenario[]) {
      const execution = runVerifierRegistryDriver(["--scenario", scenario, "--json"]);
      expect(execution.exitCode).toBe(0);
      const receipt = parseObject(execution.stdout);
      expect(Object.keys(receipt).sort()).toEqual([
        "mode",
        "observation",
        "ok",
        "resultCode",
        "scenario",
        "version",
      ]);
      expect(receipt).toMatchObject({
        mode: "scenario",
        ok: true,
        resultCode: expected[scenario][0],
        scenario,
      });
      const observation = parseObject(receipt.observation);
      expect(parseObject(observation.fact)).toMatchObject({
        type: expected[scenario][1],
        ...(expected[scenario][1] === "verification_result"
          ? { status: expected[scenario][2] }
          : { code: expected[scenario][2] }),
      });
      if (scenario === "known-bad-predicate") {
        expect(parseObject(observation.fact).checkedPredicate).toBeString();
      }
      if (scenario === "valid-native-round-trip") {
        expect(observation.roundTripEqual).toBe(true);
        expect(observation.nativeCall).toEqual({
          id: "call-native-467",
          tool: "read",
          input: { path: "evidence.json", offset: 1, limit: 20 },
        });
      }
    }

    const selfTest = runVerifierRegistryDriver(["--self-test"]);
    expect(selfTest.exitCode).toBe(0);
    expect(runVerifierRegistryDriver(["--self-test"]).stdout).toBe(selfTest.stdout);
    const receipt = parseObject(selfTest.stdout);
    expect(receipt).toMatchObject({ mode: "self_test", ok: true, scenarioRuns: 10 });
    const benchmark = parseObject(receipt.benchmark);
    expect(parseObject(benchmark.determinism)).toMatchObject({
      decision: true,
      signature: true,
      action: true,
    });
    expect(parseObject(benchmark.toolValidity).nativeRoundTripValid).toBe(true);
    expect(receipt.exposedActions).toEqual([]);
    expect(benchmark.latencyMs).toBeUndefined();

    const timed = runVerifierRegistryDriver(["--benchmark"]);
    expect(timed.exitCode).toBe(0);
    const timedReceipt = parseObject(timed.stdout);
    expect(timedReceipt.mode).toBe("benchmark");
    expect(parseObject(parseObject(timedReceipt.benchmark).latencyMs)).toMatchObject({
      measuredBy: "outer_driver_harness",
      samples: 10,
      p50: expect.any(Number),
      p95: expect.any(Number),
    });

    const help = runVerifierRegistryDriver(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.length).toBeGreaterThan(0);

    const badInput = runVerifierRegistryDriver(["--scenario", "unknown", "--json"]);
    expect(badInput.exitCode).toBe(1);
    expect(parseObject(badInput.stdout)).toMatchObject({
      mode: "argument_error",
      ok: false,
      resultCode: "invalid_arguments",
    });
  });

  test("returns a machine-readable failure when the driver boundary throws", () => {
    const argumentsProxy = new Proxy<readonly string[]>([], {
      get() {
        throw new Error("hostile argument list");
      },
    });
    const execution = runVerifierRegistryDriver(argumentsProxy);
    expect(execution.exitCode).toBe(1);
    expect(JSON.parse(execution.stdout)).toMatchObject({
      mode: "driver_error",
      ok: false,
      resultCode: "driver_threw",
    });
  });
});

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}
