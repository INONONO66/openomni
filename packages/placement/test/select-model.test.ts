import { describe, expect, it } from "bun:test";
import { Placement } from "../src/index";

const primary = { provider: "anthropic", id: "primary" };
const second = { provider: "openai", id: "second" };
const third = { provider: "google", id: "third" };
const chain = [primary, second, third];

describe("Placement.selectModel", () => {
  it("selects the primary with no failure history", () => {
    expect(Placement.selectModel(chain, [])).toEqual({
      model: primary,
      index: 0,
      exhausted: false,
    });
  });

  it("advances one candidate per advancing failure class", () => {
    expect(Placement.selectModel(chain, ["timeout"]).model).toEqual(second);
    expect(Placement.selectModel(chain, ["transient_error", "timeout"]).model).toEqual(third);
    expect(Placement.selectModel(chain, ["validation_error"]).index).toBe(1);
  });

  it("clamps to the last candidate and reports exhaustion — termination stays the retry policy's call", () => {
    const selection = Placement.selectModel(chain, ["timeout", "timeout", "timeout", "timeout"]);
    expect(selection.model).toEqual(third);
    expect(selection.index).toBe(2);
    expect(selection.exhausted).toBe(true);
  });

  for (const [reason, ownership] of [
    ["tool_error", "the tool failed, not the model"],
    ["context_overflow", "the compaction seam retries the SAME model"],
    ["aborted", "the run was cancelled"],
    ["mystery_failure", "unknown reasons stay conservative"],
  ] as const) {
    it(`never advances on ${reason} — ${ownership}`, () => {
      expect(Placement.selectModel(chain, [reason, reason]).index).toBe(0);
    });
  }

  it("counts only the advancing classes in a mixed history", () => {
    const selection = Placement.selectModel(chain, [
      "tool_error",
      "timeout",
      "context_overflow",
      "transient_error",
    ]);
    expect(selection.index).toBe(2);
    expect(selection.exhausted).toBe(false);
  });

  it("refuses an empty chain loudly", () => {
    expect(() => Placement.selectModel([], [])).toThrow("non-empty model chain");
  });

  it("a single-candidate chain absorbs every failure class at index 0", () => {
    const selection = Placement.selectModel([primary], ["timeout", "transient_error"]);
    expect(selection).toEqual({ model: primary, index: 0, exhausted: true });
  });
});
