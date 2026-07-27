/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { VerifierRegistry } from "../../src/evidence";

describe("VerifierRegistry", () => {
  test("known-bad evidence deterministically refutes the repository predicate", () => {
    expect(
      VerifierRegistry.verify({
        verifierId: "builtin:known-bad-fixture",
        verifierVersion: "1",
        input: { fixture: "known-bad" },
      }),
    ).toEqual({
      version: "verifier-ref-v1",
      verifierId: "builtin:known-bad-fixture",
      verifierVersion: "1",
      family: "refutation",
      checkedPredicate: "fixture must not satisfy asserted claim",
      verdict: "refuted",
    });
  });

  test("exact JSON verifier discriminates matching and mismatching canonical values", () => {
    const matching = VerifierRegistry.verify({
      verifierId: "builtin:exact-json",
      verifierVersion: "1",
      input: { expected: { b: 2, a: 1 }, actual: { a: 1, b: 2 } },
    });
    const mismatching = VerifierRegistry.verify({
      verifierId: "builtin:exact-json",
      verifierVersion: "1",
      input: { actual: [1, 2], expected: [2, 1] },
    });

    expect(matching).toEqual({
      version: "verifier-ref-v1",
      verifierId: "builtin:exact-json",
      verifierVersion: "1",
      family: "deterministic",
      checkedPredicate: "canonical input equals canonical expected",
      verdict: "verified",
    });
    expect(mismatching.verdict).toBe("refuted");
  });

  test("exact JSON preserves own enumerable __proto__ values when comparing", () => {
    const matchingActual = Object.create(null) as Record<string, VerifierRegistry.Serializable>;
    const matchingExpected = Object.create(null) as Record<string, VerifierRegistry.Serializable>;
    const mismatchingExpected = Object.create(null) as Record<
      string,
      VerifierRegistry.Serializable
    >;
    Object.defineProperty(matchingActual, "__proto__", {
      value: { marker: "same" },
      enumerable: true,
    });
    Object.defineProperty(matchingExpected, "__proto__", {
      value: { marker: "same" },
      enumerable: true,
    });
    Object.defineProperty(mismatchingExpected, "__proto__", {
      value: { marker: "different" },
      enumerable: true,
    });

    expect(
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: { actual: matchingActual, expected: matchingExpected },
      }).verdict,
    ).toBe("verified");
    expect(
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: { actual: matchingActual, expected: mismatchingExpected },
      }).verdict,
    ).toBe("refuted");
  });

  test("unsupported verifier identifiers and versions fail loudly", () => {
    expect(() =>
      VerifierRegistry.verify({ verifierId: "missing", verifierVersion: "1", input: null }),
    ).toThrow(VerifierRegistry.UnsupportedVerifierError);
    expect(() =>
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "2",
        input: { actual: null, expected: null },
      }),
    ).toThrow(VerifierRegistry.UnsupportedVerifierError);
  });

  test("catalog inputs use exact closed schemas", () => {
    expect(() =>
      VerifierRegistry.verify({
        verifierId: "builtin:known-bad-fixture",
        verifierVersion: "1",
        input: { fixture: "known-bad", extra: true },
      }),
    ).toThrow(VerifierRegistry.InvalidVerifierInputError);
    expect(() =>
      VerifierRegistry.verify({
        verifierId: "builtin:known-bad-fixture",
        verifierVersion: "1",
        input: { fixture: 1 },
      }),
    ).toThrow(VerifierRegistry.InvalidVerifierInputError);
    expect(() =>
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: { actual: null },
      }),
    ).toThrow(VerifierRegistry.InvalidVerifierInputError);
  });

  test("closed verifier input rejects an own enumerable __proto__ top-level key", () => {
    const input = Object.create(null) as Record<string, VerifierRegistry.Serializable>;
    input.actual = null;
    input.expected = null;
    Object.defineProperty(input, "__proto__", {
      value: "extra",
      enumerable: true,
    });

    expect(() =>
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input,
      }),
    ).toThrow(VerifierRegistry.InvalidVerifierInputError);
  });

  test.each([
    ["non-finite number", { actual: Number.NaN, expected: null }],
    ["non-plain object", { actual: new Date(0), expected: null }],
    ["runtime-unserializable value", { actual: undefined, expected: null }],
  ])("rejects %s during canonicalization", (_label, input) => {
    expect(() =>
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: input as unknown as VerifierRegistry.Serializable,
      }),
    ).toThrow(VerifierRegistry.NonSerializableVerifierInputError);
  });

  test("rejects cyclic input during canonicalization", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() =>
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: { actual: cycle, expected: null } as unknown as VerifierRegistry.Serializable,
      }),
    ).toThrow(VerifierRegistry.NonSerializableVerifierInputError);
  });

  test("rejects record getters without invoking them", () => {
    let invocations = 0;
    const actual = {} as Record<string, VerifierRegistry.Serializable>;
    Object.defineProperty(actual, "value", {
      get() {
        invocations += 1;
        return "hidden";
      },
      enumerable: true,
    });

    const verify = () =>
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: { actual, expected: null },
      });

    expect(verify).toThrow(VerifierRegistry.NonSerializableVerifierInputError);
    expect(verify).toThrow(/^\$input\.actual\.value must be an own data property$/);
    expect(invocations).toBe(0);
  });

  test("rejects array index getters without invoking them", () => {
    let invocations = 0;
    const actual: VerifierRegistry.Serializable[] = [];
    Object.defineProperty(actual, "0", {
      get() {
        invocations += 1;
        return "hidden";
      },
      enumerable: true,
      configurable: true,
    });

    const verify = () =>
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: { actual, expected: null },
      });

    expect(verify).toThrow(VerifierRegistry.NonSerializableVerifierInputError);
    expect(verify).toThrow(/^\$input\.actual\[0\] must be an own data property$/);
    expect(invocations).toBe(0);
  });

  test("ignores overridden array iterators without invoking them", () => {
    let invocations = 0;
    const actual = [1, 2];
    Object.defineProperty(actual, Symbol.iterator, {
      value() {
        invocations += 1;
        throw new Error("iterator must not execute");
      },
    });

    expect(
      VerifierRegistry.verify({
        verifierId: "builtin:exact-json",
        verifierVersion: "1",
        input: { actual, expected: [1, 2] },
      }).verdict,
    ).toBe("verified");
    expect(invocations).toBe(0);
  });

  test("normalizes negative zero to canonical zero", () => {
    const result = VerifierRegistry.verify({
      verifierId: "builtin:exact-json",
      verifierVersion: "1",
      input: { actual: -0, expected: 0 },
    });
    let observed: VerifierRegistry.Serializable | undefined;
    VerifierRegistry.assertFunctionRepeatable((input) => {
      observed = input;
      return input;
    }, -0);

    expect(result.verdict).toBe("verified");
    expect(observed).toBe(0);
    expect(Object.is(observed, -0)).toBe(false);
  });

  test("passes only deeply frozen canonical input to repeatability candidates", () => {
    const observed: VerifierRegistry.Serializable[] = [];
    const source = { z: 1, nested: { b: 2, a: 1 } };

    VerifierRegistry.assertFunctionRepeatable((input) => {
      observed.push(input);
      return Object.isFrozen(input) &&
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.isFrozen(input.nested)
        ? "frozen"
        : "mutable";
    }, source);

    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(source);
    expect(observed[1]).not.toBe(observed[0]);
    expect(Object.keys(observed[0] as object)).toEqual(["nested", "z"]);
    expect(Object.isFrozen(source)).toBe(false);
  });

  test("normalizes records to frozen null-prototype data properties without dropping keys", () => {
    const source = Object.create(null) as Record<string, VerifierRegistry.Serializable>;
    Object.defineProperty(source, "__proto__", {
      value: "preserved",
      enumerable: true,
    });
    let observed: VerifierRegistry.Serializable | undefined;

    VerifierRegistry.assertFunctionRepeatable((input) => {
      observed = input;
      return null;
    }, source);

    expect(typeof observed).toBe("object");
    expect(observed).not.toBeNull();
    expect(Object.getPrototypeOf(observed)).toBeNull();
    expect(Object.keys(observed as object)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(observed, "__proto__")).toEqual({
      value: "preserved",
      enumerable: true,
      configurable: false,
      writable: false,
    });
  });

  test("identical trusted input repeats byte-identically", () => {
    const repeated = VerifierRegistry.assertRepeatable({
      verifierId: "builtin:exact-json",
      verifierVersion: "1",
      input: { expected: "accepted", actual: "accepted" },
    });

    expect(new TextDecoder().decode(repeated.bytes)).toBe(
      '{"checkedPredicate":"canonical input equals canonical expected","family":"deterministic","verdict":"verified","verifierId":"builtin:exact-json","verifierVersion":"1","version":"verifier-ref-v1"}',
    );
    expect(Object.isFrozen(repeated)).toBe(true);
    expect(Object.isFrozen(repeated.result)).toBe(true);
  });

  test("untrusted helper detects nondeterminism without minting a verifier reference", () => {
    let calls = 0;
    expect(() =>
      VerifierRegistry.assertFunctionRepeatable(() => {
        calls += 1;
        return calls % 2 === 1 ? "verified" : "refuted";
      }, null),
    ).toThrow(VerifierRegistry.NonDeterministicVerifierError);
    expect(calls).toBe(2);
  });

  test("catalog construction and mutation are not public capabilities", () => {
    const publicApi = VerifierRegistry as unknown as Record<string, unknown>;
    expect(publicApi.create).toBeUndefined();
    expect(publicApi.register).toBeUndefined();
    expect(publicApi.catalog).toBeUndefined();
    expect(Object.isFrozen(VerifierRegistry.FAMILIES)).toBe(true);
    expect(Object.isFrozen(VerifierRegistry)).toBe(true);

    const result = VerifierRegistry.verify({
      verifierId: "builtin:known-bad-fixture",
      verifierVersion: "1",
      input: { fixture: "not-known-bad" },
    });
    expect(result.verdict).toBe("asserted");
    expect(() => Object.assign(result, { verdict: "verified" })).toThrow();
    expect(result.verdict).toBe("asserted");
  });
});
