import { describe, expect, it } from "bun:test";
import { entropyOf } from "../../src/core/entropy";

describe("entropyOf", () => {
  it("returns the injected source untouched", () => {
    const entropy = () => "fixed";
    expect(entropyOf({ entropy })).toBe(entropy);
  });

  it("defaults to a fresh uuid per call", () => {
    const entropy = entropyOf({});
    const first = entropy();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(entropy()).not.toBe(first);
  });
});
