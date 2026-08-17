import { describe, expect, test } from "bun:test";
import type { Tool } from "@openomni/protocol";
// Internal module import on purpose: ToolCallResult left the package barrel in
// the #audit dead-surface pass (zero external importers), but the alias
// contract against protocol Tool.Result still holds inside the package.
import type { ToolCallResult } from "../../src/worker-supervision/supervisor-types";

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
