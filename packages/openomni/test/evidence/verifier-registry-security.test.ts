/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  hashCanonicalJson,
} from "../../src/evidence/verifier-conformance-canonical";
import { compileObligation } from "../../src/evidence/verifier-registry-evaluators";
import { VerifierRegistry } from "../../src/evidence/verifier-registry";
import { executeSandboxInstruction } from "../../src/evidence/verifier-sandbox";

const digest = `sha256:${"a".repeat(64)}`;

function obligation(
  kind: VerifierRegistry.ObligationKind,
  recordedInputs: VerifierRegistry.JsonValue,
  claim = "recorded predicate",
) {
  return {
    obligationId: `obligation:${kind}`,
    kind,
    claim,
    recordedInputs,
  };
}

describe("verifier registry security boundaries", () => {
  test("rejects non-JSON identity aliases before canonicalization", () => {
    expect(() => canonicalJson(new Error("not JSON"))).toThrow();
    expect(() => canonicalJson(/not-json/u)).toThrow();
    expect(() => canonicalJson(Object.create({ inherited: true }))).toThrow();
    expect(() =>
      canonicalJson(JSON.parse('{"safe":1,"__proto__":{"effect":"persist"}}')),
    ).toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();

    let nested: unknown = null;
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    expect(() => canonicalJson(nested)).toThrow();
    expect(() => canonicalJson(-0)).toThrow();

    expect(() => canonicalJson(new Array(1))).toThrow();
    const extended = [1];
    Object.defineProperty(extended, "extra", { value: 2, enumerable: true });
    expect(() => canonicalJson(extended)).toThrow();
    const accessor = [1];
    Object.defineProperty(accessor, "0", { get: () => 1, enumerable: true });
    expect(() => canonicalJson(accessor)).toThrow();
    const symbol = [1];
    Object.defineProperty(symbol, Symbol("hidden"), { value: 2 });
    expect(() => canonicalJson(symbol)).toThrow();
  });

  test("refutes native calls whose schema parse would drop fields", () => {
    const fact = VerifierRegistry.create().verify(
      obligation("schema_validity", {
        schema: "native_tool_call",
        value: {
          id: "call-1",
          tool: "read",
          input: { path: "evidence.json" },
          actions: ["persist"],
        },
      }),
    );
    expect(fact).toMatchObject({
      type: "verification_result",
      status: "refuted",
      checkedPredicate: expect.any(String),
    });
  });

  test("binds every scoped result to its complete immutable basis", () => {
    const registry = VerifierRegistry.create();
    const first = registry.verify(
      obligation("numeric_recheck", { operator: "eq", left: 1, right: 1 }, "first claim"),
    );
    const second = registry.verify(
      obligation("numeric_recheck", { operator: "eq", left: 2, right: 2 }, "second claim"),
    );

    if (first.type !== "verification_result" || second.type !== "verification_result") {
      throw new Error("expected verification results");
    }
    expect(first.status).toBe("verified");
    expect(second.status).toBe("verified");
    expect(first.basisHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.basisHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.basisHash).not.toBe(second.basisHash);
    expect(first.basisHash).toBe(
      hashCanonicalJson({
        version: "verification-basis-v1",
        obligation: obligation(
          "numeric_recheck",
          { operator: "eq", left: 1, right: 1 },
          "first claim",
        ),
        verifierId: "builtin.numeric-v1",
      }),
    );
  });

  test("evaluates and hashes one immutable snapshot of exotic inputs", () => {
    let descriptorReads = 0;
    const switching = new Proxy(
      { operator: "eq", left: 1, right: 1 },
      {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          if (property !== "left" || descriptor === undefined || !("value" in descriptor)) {
            return descriptor;
          }
          descriptorReads += 1;
          return { ...descriptor, value: descriptorReads % 2 === 1 ? 1 : 2 };
        },
      },
    );
    const registry = VerifierRegistry.create();
    const switched = registry.verify(obligation("numeric_recheck", switching));
    const verified = registry.verify(
      obligation("numeric_recheck", { operator: "eq", left: 1, right: 1 }),
    );
    const refuted = registry.verify(
      obligation("numeric_recheck", { operator: "eq", left: 2, right: 1 }),
    );
    if (
      switched.type !== "verification_result" ||
      verified.type !== "verification_result" ||
      refuted.type !== "verification_result"
    ) {
      throw new Error("expected verification results");
    }
    expect(
      switched.status === "verified"
        ? switched.basisHash === verified.basisHash
        : switched.basisHash === refuted.basisHash,
    ).toBe(true);
    expect(Object.isFrozen(switched)).toBe(true);
  });

  test("returns typed malformed input for oversized registry boundaries", () => {
    const fact = VerifierRegistry.create().verify({
      obligationId: "oversized",
      kind: "numeric_recheck",
      claim: "x".repeat(65_537),
      recordedInputs: { operator: "eq", left: 1, right: 1 },
    });
    expect(fact).toMatchObject({ type: "verification_error", code: "malformed_input" });
  });

  test("rejects impossible result taxonomy and status combinations", () => {
    const base = {
      type: "verification_result",
      obligationId: "obligation:reasoning",
      verifierId: "asserted-only",
      basisHash: digest,
    };
    expect(() =>
      VerifierRegistry.VerificationResult.parse({
        ...base,
        kind: "reasoning",
        status: "verified",
        checkedPredicate: "forbidden decisive result",
      }),
    ).toThrow();
    expect(() =>
      VerifierRegistry.VerificationResult.parse({
        ...base,
        kind: "numeric_recheck",
        status: "asserted",
      }),
    ).toThrow();
  });

  test("compiles obligations to data-only closed sandbox instructions", () => {
    const compiled = compileObligation(
      VerifierRegistry.Obligation.parse(
        obligation("numeric_recheck", { operator: "eq", left: 4, right: 4 }),
      ),
    );
    if ("type" in compiled) throw new Error("expected compiled verifier instruction");
    expect(JSON.parse(JSON.stringify(compiled.instruction))).toEqual(compiled.instruction);
    expect(hasFunction(compiled.instruction)).toBe(false);
    expect(executeSandboxInstruction(compiled.instruction)).toEqual({
      status: "verified",
      checkedPredicate: "recorded numeric operands satisfy eq",
    });
  });
});

function hasFunction(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(hasFunction);
}
