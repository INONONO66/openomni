/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  ReplayConformanceError,
  fuzzCommutativeInterleavings,
  substituteRecordedOutputs,
} from "../../src/evidence/verifier-conformance";

const digestA = `sha256:${"a".repeat(64)}`;

function captureConformanceError(action: () => unknown): ReplayConformanceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ReplayConformanceError) return error;
    throw error;
  }
  throw new Error("expected ReplayConformanceError");
}

describe("verifier replay interleaving and substitution conformance", () => {
  test("deterministically fuzzes only explicitly commutative interleavings", () => {
    const plan = {
      seed: 73,
      iterations: 12,
      initialFold: 0,
      events: [
        { id: "a", commutativeGroup: "sum", value: 1 },
        { id: "b", commutativeGroup: "sum", value: 2 },
        { id: "c", commutativeGroup: "sum", value: 3 },
      ],
    };
    const sum = (state: unknown, event: { value: unknown }) => {
      if (typeof state !== "number" || typeof event.value !== "number") {
        throw new Error("numeric fold required");
      }
      return state + event.value;
    };
    expect(fuzzCommutativeInterleavings(plan, sum)).toEqual(
      fuzzCommutativeInterleavings(plan, sum),
    );
    const report = fuzzCommutativeInterleavings(plan, sum);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.interleavingHashes)).toBe(true);
    expect(Object.isFrozen(plan.events)).toBe(false);

    const concatenate = (state: unknown, event: { value: unknown }) => {
      if (typeof state !== "string" || typeof event.value !== "string") {
        throw new Error("string fold required");
      }
      return state + event.value;
    };
    const falseDeclaration = captureConformanceError(() =>
      fuzzCommutativeInterleavings(
        {
          seed: 73,
          iterations: 1,
          initialFold: "",
          events: [
            { id: "a", commutativeGroup: "not-really", value: "a" },
            { id: "b", commutativeGroup: "not-really", value: "b" },
            { id: "c", commutativeGroup: "not-really", value: "c" },
          ],
        },
        concatenate,
      ),
    );
    expect(falseDeclaration.facts).toMatchObject({
      kind: "interleaving_mismatch",
      seed: 73,
    });

    expect(
      fuzzCommutativeInterleavings(
        {
          seed: 73,
          iterations: 4,
          initialFold: "",
          events: [
            { id: "a", commutativeGroup: "isolated", value: "a" },
            { id: "barrier", value: "-" },
            { id: "b", commutativeGroup: "isolated", value: "b" },
          ],
        },
        concatenate,
      ).iterations,
    ).toBe(4);
  });

  test("substitutes recorded outputs without mutating the caller cassette", () => {
    const commands = [
      { op: "llm", promptHash: digestA },
      { op: "device", id: "lamp" },
    ];
    const cassette = [
      { command: commands[0], output: { text: "recorded" } },
      { command: commands[1], output: { status: "off" } },
    ];

    const outputs = substituteRecordedOutputs(commands, cassette);
    expect(outputs).toEqual([{ text: "recorded" }, { status: "off" }]);
    expect(Object.isFrozen(cassette[0]?.output)).toBe(false);
    expect(Object.isFrozen(outputs[0])).toBe(true);
    expect(
      captureConformanceError(() => substituteRecordedOutputs(commands.slice(0, 1), cassette))
        .facts,
    ).toMatchObject({ kind: "missing_command", index: 1 });
    expect(
      captureConformanceError(() => substituteRecordedOutputs(commands, cassette.slice(0, 1)))
        .facts,
    ).toMatchObject({ kind: "unexpected_command", index: 1 });
    expect(
      captureConformanceError(() =>
        substituteRecordedOutputs([{ op: "network", url: "redacted" }, commands[1]], cassette),
      ).facts,
    ).toMatchObject({ kind: "command_mismatch", index: 0 });
  });

  test("rejects plans whose cumulative fold work exceeds the frozen budget", () => {
    expect(() =>
      fuzzCommutativeInterleavings(
        {
          seed: 1,
          iterations: 1_000,
          initialFold: Array.from({ length: 1_000 }, () => 0),
          events: [{ id: "identity", value: null }],
        },
        (state) => state,
      ),
    ).toThrow("interleaving fold work budget exceeded");
  });
});
