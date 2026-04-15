import { describe, expect, it } from "bun:test";
import { detectMode } from "../../src/ingress/mode";

describe("detectMode", () => {
  it("detects /plan and strips the prefix", () => {
    expect(detectMode("/plan build auth")).toEqual({
      mode: "plan",
      text: "build auth",
    });
  });

  it("defaults to direct mode for plain text", () => {
    expect(detectMode("hello")).toEqual({
      mode: "direct",
      text: "hello",
    });
  });
});
