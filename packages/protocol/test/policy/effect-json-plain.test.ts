import { expect, test } from "bun:test";
import { Policy } from "../../src/policy/index";

test("rejects non-JSON-plain effect values", () => {
  for (const value of [
    { nested: () => "not data" },
    { nested: new Date(0) },
    { nested: 1n },
    { nested: [undefined] },
  ]) {
    expect(
      Policy.PolicyEffect.safeParse({ type: "tool.rewrite_input", input: value }).success,
    ).toBe(false);
  }
});

test("rejects reserved object keys in effect values", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const value = JSON.parse(`{"${key}": "not an ordinary data property"}`);
    expect(
      Policy.PolicyEffect.safeParse({ type: "tool.rewrite_input", input: value }).success,
    ).toBe(false);
  }
});

test("rejects sparse arrays and arrays carrying named properties", () => {
  const sparse: unknown[] = [1];
  sparse.length = 2;
  const namedProp = Object.assign([1, 2], { extra: "lost by JSON serialization" });
  // Cancellation shape: one hole + one named property keeps the enumerable
  // key count equal to length — only the canonical-index check refuses it.
  const cancellation: unknown[] = [1];
  cancellation.length = 2;
  Object.assign(cancellation, { extra: "x" });
  for (const value of [sparse, namedProp, cancellation]) {
    expect(
      Policy.PolicyEffect.safeParse({ type: "tool.rewrite_input", input: { items: value } })
        .success,
    ).toBe(false);
  }
});

test("round-trips JSON-plain effect values unchanged", () => {
  const input = {
    nested: { nullValue: null, enabled: true, count: 3, text: "value" },
    items: ["first", 2, false, null],
  };
  const effect = Policy.PolicyEffect.parse({ type: "tool.rewrite_input", input }) as Extract<
    Policy.PolicyEffect,
    { type: "tool.rewrite_input" }
  >;

  expect(JSON.parse(JSON.stringify(effect.input))).toEqual(input);
  expect(effect.input).toEqual(input);
});
