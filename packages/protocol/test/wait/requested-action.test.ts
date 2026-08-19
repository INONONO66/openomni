import { describe, expect, test } from "bun:test";
import { Wait } from "../../src/wait/index.js";

describe("Wait.requestedWaitAction", () => {
  test("defaults an absent action to report_result", () => {
    expect(Wait.requestedWaitAction("plain text reply")).toBe("report_result");
    expect(Wait.requestedWaitAction(undefined)).toBe("report_result");
    expect(Wait.requestedWaitAction(null)).toBe("report_result");
    expect(Wait.requestedWaitAction({ output: "SN-A2334" })).toBe("report_result");
  });

  test("parses a valid enum member to itself", () => {
    expect(Wait.requestedWaitAction({ action: "report_result" })).toBe("report_result");
    expect(Wait.requestedWaitAction({ action: "ask_clarification" })).toBe("ask_clarification");
    expect(Wait.requestedWaitAction({ action: "attach_artifact" })).toBe("attach_artifact");
    expect(Wait.requestedWaitAction({ action: "decline_task" })).toBe("decline_task");
  });

  test("parses a present-but-invalid action to the typed sentinel, never the default", () => {
    expect(Wait.requestedWaitAction({ action: "unknown" })).toBe("invalid");
    expect(Wait.requestedWaitAction({ action: 42 })).toBe("invalid");
    expect(Wait.requestedWaitAction({ action: null })).toBe("invalid");
    expect(Wait.requestedWaitAction({ action: "REPORT_RESULT" })).toBe("invalid");
  });
});
