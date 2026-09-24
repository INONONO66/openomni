import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { Effect } from "effect";
import { expect, it } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { ExecutionApprovalRequest, ExecutionApprovals } from "../src/executor-contract";
import { sessionStopEvidence } from "../src/session-stop-evidence";
import { isolated } from "./helpers/isolated";

function approvalsWith(ids: readonly string[]): ExecutionApprovals {
  return {
    pending: () => ids.map((id: string) => ({ id }) as ExecutionApprovalRequest),
    answer: () => Effect.void,
  };
}
function seed() {
  return SessionHandleStore.materialize({ id: "evidence", parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] }, policyGeneration: 1, actionId: "configure", at: 0 });
}

it("reports armed alarms of this turn and every open intent from obligations and pending approvals", () => isolated(Effect.gen(function* () {
  yield* seed();
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("missing alarm adapter");
  const evidence = sessionStopEvidence("evidence", "turn", () => approvalsWith(["approval-1"]), () => Effect.succeed([{ actionId: "obligation-1", kind: "message" as const }]));
  yield* alarms.arm({ id: "alarm-1", sessionId: "evidence", kind: "at", fireAt: 5_000 });
  expect(yield* evidence()).toEqual({ progress: true, blocked: false, openIntent: ["obligation-1", "approval-1"], alarmIds: ["alarm-1"] });
})));

it("ignores alarms that are no longer armed and reports nothing when no obligations exist", () => isolated(Effect.gen(function* () {
  yield* seed();
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("missing alarm adapter");
  const evidence = sessionStopEvidence("evidence", "turn", () => undefined);
  yield* alarms.arm({ id: "alarm-1", sessionId: "evidence", kind: "at", fireAt: 5_000 });
  const owned = yield* alarms.acquire("alarm-1", 0);
  yield* alarms.fire({ id: "alarm-1", epoch: owned.epoch, fence: owned.fence, sourceKey: `timer:${owned.fireAt}`, at: 5_000, content: "woke", terminal: true });
  expect(sessionTree("evidence").some((action: import("@openomni/protocol").LedgerAction.Node) => action.kind === "alarm.arm")).toBe(true);
  expect(yield* evidence()).toEqual({ progress: true, blocked: false, openIntent: [], alarmIds: [] });
})));
