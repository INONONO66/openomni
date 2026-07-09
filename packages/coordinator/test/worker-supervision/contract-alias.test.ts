import { describe, expect, test } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { ToolCallResult } from "../../src/index";

type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type AssertExact<A, B> = IsExact<A, B> extends true ? true : never;

const toolCallResultIsProtocolResult: AssertExact<ToolCallResult, Tool.Result> = true;

describe("worker-supervision submodule contracts", () => {
  test("ToolCallResult intentionally tracks the protocol Tool.Result contract", () => {
    expect(toolCallResultIsProtocolResult).toBe(true);
  });
});
