import { afterEach, beforeEach, expect, it } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { ExecutionApprovalRequest, ExecutionApprovals } from "../src/executor-contract";
import { sessionStopEvidence } from "../src/session-stop-evidence";
import { requestLedger } from "./helpers/request-ledger";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
});
afterEach(() => {
  Storage.reset();
});

function approvalsWith(ids: readonly string[]): ExecutionApprovals {
  return {
    pending: () => ids.map((id) => ({ id }) as ExecutionApprovalRequest),
    answer: async () => undefined,
  };
}

it("reports armed alarms of this turn and every open intent from obligations and pending approvals", async () => {
  const { identity } = requestLedger({ id: "evidence" });
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("missing alarm adapter");
  const openIntent = async () => [{ actionId: "obligation-1", kind: "message" as const }];
  const evidence = sessionStopEvidence(
    "evidence",
    identity.turnId,
    () => approvalsWith(["approval-1"]),
    openIntent,
  );

  alarms.arm({ id: "alarm-1", sessionId: "evidence", kind: "at", fireAt: 5_000 });

  await expect(evidence()).resolves.toEqual({
    progress: true,
    blocked: false,
    openIntent: ["obligation-1", "approval-1"],
    alarmIds: ["alarm-1"],
  });
});

it("ignores alarms that are no longer armed and reports nothing when no obligations exist", async () => {
  const { identity } = requestLedger({ id: "evidence" });
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("missing alarm adapter");
  const evidence = sessionStopEvidence("evidence", identity.turnId, () => undefined);

  alarms.arm({ id: "alarm-1", sessionId: "evidence", kind: "at", fireAt: 5_000 });
  const owned = alarms.acquire("alarm-1", 0);
  if (owned === undefined) throw new Error("alarm acquisition refused");
  alarms.fire({
    id: "alarm-1",
    epoch: owned.epoch,
    fence: owned.fence,
    sourceKey: `timer:${owned.fireAt}`,
    at: 5_000,
    content: "woke",
    terminal: true,
  });
  expect(SessionHandleStore.tree("evidence").some((action) => action.kind === "alarm.arm")).toBe(
    true,
  );

  await expect(evidence()).resolves.toEqual({
    progress: true,
    blocked: false,
    openIntent: [],
    alarmIds: [],
  });
});
