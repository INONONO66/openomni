import { describe, expect, test } from "bun:test";
import { requestedWaitAction } from "../../src/wait/requested-action";

describe("requestedWaitAction", () => {
  test("defaults an absent action to report_result", () => {
    expect(requestedWaitAction("plain text reply")).toBe("report_result");
    expect(requestedWaitAction(undefined)).toBe("report_result");
    expect(requestedWaitAction(null)).toBe("report_result");
    expect(requestedWaitAction({ output: "SN-A2334" })).toBe("report_result");
  });

  test("parses a valid enum member to itself", () => {
    expect(requestedWaitAction({ action: "report_result" })).toBe("report_result");
    expect(requestedWaitAction({ action: "ask_clarification" })).toBe("ask_clarification");
    expect(requestedWaitAction({ action: "attach_artifact" })).toBe("attach_artifact");
    expect(requestedWaitAction({ action: "decline_task" })).toBe("decline_task");
  });

  test("parses a present-but-invalid action to the typed sentinel, never the default", () => {
    expect(requestedWaitAction({ action: "unknown" })).toBe("invalid");
    expect(requestedWaitAction({ action: 42 })).toBe("invalid");
    expect(requestedWaitAction({ action: null })).toBe("invalid");
    expect(requestedWaitAction({ action: "REPORT_RESULT" })).toBe("invalid");
  });
});
