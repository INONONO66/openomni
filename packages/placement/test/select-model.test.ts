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

  it("never advances on tool_error — the tool failed, not the model", () => {
    expect(Placement.selectModel(chain, ["tool_error", "tool_error"]).index).toBe(0);
  });

  it("never advances on context_overflow — the compaction seam retries the SAME model", () => {
    expect(Placement.selectModel(chain, ["context_overflow"]).index).toBe(0);
  });

  it("never advances on aborted", () => {
    expect(Placement.selectModel(chain, ["aborted"]).index).toBe(0);
  });

  it("stays conservative on unknown reason strings", () => {
    expect(Placement.selectModel(chain, ["mystery_failure"]).index).toBe(0);
  });

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

  it("is deterministic — same inputs, same selection", () => {
    const a = Placement.selectModel(chain, ["timeout"]);
    const b = Placement.selectModel(chain, ["timeout"]);
    expect(a).toEqual(b);
  });

  it("refuses an empty chain loudly", () => {
    expect(() => Placement.selectModel([], [])).toThrow("non-empty model chain");
  });

  it("a single-candidate chain absorbs every failure class at index 0", () => {
    const selection = Placement.selectModel([primary], ["timeout", "transient_error"]);
    expect(selection.model).toEqual(primary);
    expect(selection.index).toBe(0);
    expect(selection.exhausted).toBe(true);
  });
});
