import { describe, expect, it } from "bun:test";
import { Cause } from "effect";
import { ForeignFailure, Interrupted } from "../src/errors";
import * as Failure from "../src/failure";

describe("Failure.of", () => {
  it("returns the typed error instance a Cause carries", () => {
    const error = new Interrupted();
    expect(Failure.of(Cause.fail(error), "op")).toBe(error);
  });

  it("synthesizes a ForeignFailure for a defect, carrying the pretty-printed cause", () => {
    const cause = Cause.die(new Error("boom"));
    const failure = Failure.of(cause, "stage.op");
    expect(failure).toBeInstanceOf(ForeignFailure);
    expect(failure).toMatchObject({ _tag: "ForeignFailure", operation: "stage.op", cause: expect.stringContaining("boom") });
  });

  it("synthesizes a ForeignFailure for an interrupt", () => {
    const failure = Failure.of(Cause.interrupt(), "stage.op.completion");
    expect(failure).toBeInstanceOf(ForeignFailure);
    expect(failure).toMatchObject({ operation: "stage.op.completion" });
  });
});

describe("Failure.fromCause", () => {
  it("applies the synthesizer to defects and returns the typed error otherwise", () => {
    const error = new Interrupted();
    const synthesize = (pretty: string) => ({ synthesized: pretty });
    expect(Failure.fromCause(Cause.fail(error), synthesize)).toBe(error);
    expect(Failure.fromCause(Cause.die("bad"), synthesize)).toEqual({ synthesized: expect.stringContaining("bad") });
  });
});
