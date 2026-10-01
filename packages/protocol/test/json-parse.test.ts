import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseJson } from "../src/index.js";

const Envelope = z.object({ op: z.number(), t: z.string().optional() });

describe("parseJson", () => {
  test("valid JSON that satisfies the schema yields the parsed value", () => {
    expect(parseJson(Envelope, '{"op":10,"t":"READY"}')).toEqual({ op: 10, t: "READY" });
  });

  test("text that is not JSON yields undefined", () => {
    expect(parseJson(Envelope, "{not json")).toBeUndefined();
  });

  test("valid JSON that fails the schema yields undefined", () => {
    expect(parseJson(Envelope, '{"op":"ten"}')).toBeUndefined();
  });

  test("a schema whose validation throws yields undefined without escaping", () => {
    const Throwing = z.custom<number>(() => {
      throw new Error("boom");
    });
    expect(() => parseJson(Throwing, "1")).not.toThrow();
    expect(parseJson(Throwing, "1")).toBeUndefined();
  });
});
