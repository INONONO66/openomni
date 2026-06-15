import { describe, expect, test } from "bun:test";
import { enforceTimeoutAndAbort } from "./executor-abort.js";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";

describe("enforceTimeoutAndAbort", () => {
  test("keeps timeout rejection authoritative when timeout callback throws", async () => {
    const neverSettles = new Promise<unknown>(() => undefined);
    let caught: unknown;

    try {
      await enforceTimeoutAndAbort(neverSettles, 1, undefined, () => {
        throw Object.create(null);
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolRuntimePolicyMiddleware.TimeoutError);
    expect(caught).toMatchObject({ timeoutMs: 1 });
  });
});
