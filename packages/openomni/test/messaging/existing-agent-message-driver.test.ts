import { describe, expect, test } from "bun:test";
import { runExistingAgentMessageDriver } from "../../src/messaging/index.js";

/**
 * Manual QA driver scenarios via direct invocation (#215). The driver runs
 * under its own Bus/Storage isolation, so these tests assert the exact JSON
 * receipt contract the issue pins.
 */

describe("existing-agent-message-driver", () => {
  test("restart-quorum resolves a persisted 2-of-3 Wait for the original owner without allocation", async () => {
    const result = await runExistingAgentMessageDriver(["--scenario", "restart-quorum", "--json"]);

    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.resultCode).toBe("restart_quorum_resolved");
    expect(receipt.allocationDelta).toBe(0);
    expect(receipt.ownerRef).toEqual({ kind: "session", id: "session:qa-owner" });
    expect(receipt.waitStatus).toBe("resolved");
    expect(receipt.resumeReceipts).toHaveLength(1);
    expect(receipt.resumeReceipts[0]).toMatchObject({
      waitId: "wait:qa:briefing",
      ownerRef: { kind: "session", id: "session:qa-owner" },
    });
    expect(receipt.fireAndForget).toEqual({ outcome: "sent", waitCountAfterSend: 0 });
    expect(receipt.restart).toEqual({
      storageReopened: true,
      statusAtRestart: "open",
      repliesPersistedAcrossRestart: 1,
    });
    expect(receipt.deliveries).toHaveLength(2);
  });

  test("duplicate-ambiguous observes both typed denials with unchanged quorum and no Worker", async () => {
    const result = await runExistingAgentMessageDriver([
      "--scenario",
      "duplicate-ambiguous",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.resultCode).toBe("duplicate_and_ambiguous_denied");
    expect(receipt.denials).toEqual([
      { plane: "reply", code: "duplicate_reply" },
      { plane: "reply", code: "ambiguous_responder" },
      { plane: "messaging", code: "target_ambiguous" },
    ]);
    expect(receipt.quorum.unchanged).toBe(true);
    expect(receipt.quorum.after).toEqual({
      status: "open",
      replies: 1,
      responders: 1,
      threshold: 2,
    });
    expect(receipt.workerAllocated).toBe(false);
    expect(receipt.allocationDelta).toBe(0);
  });

  test("scenario runs are deterministic — identical receipts on repeat invocation", async () => {
    const first = await runExistingAgentMessageDriver([
      "--scenario",
      "duplicate-ambiguous",
      "--json",
    ]);
    const second = await runExistingAgentMessageDriver([
      "--scenario",
      "duplicate-ambiguous",
      "--json",
    ]);

    expect(first.stdout).toBe(second.stdout);
  });

  test("invalid arguments exit nonzero with the typed invalid_arguments result", async () => {
    const result = await runExistingAgentMessageDriver(["--scenario", "unknown", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).resultCode).toBe("invalid_arguments");
  });
});
