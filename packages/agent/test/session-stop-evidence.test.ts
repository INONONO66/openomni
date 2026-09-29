import { Effect } from "effect";
import { expect, it } from "bun:test";
import type { LedgerAction } from "@openomni/protocol";
import type { ExecutionApprovalRequest, ExecutionApprovals } from "../src/executor-contract";
import { sessionStopEvidence } from "../src/session-stop-evidence";
import { fencedTurnFixture, type FencedTurnFixture } from "./helpers/fenced-writer";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { sessionTree } from "./helpers/session-tree";

function approvalsWith(ids: readonly string[]): ExecutionApprovals {
  return {
    pending: () => ids.map((id: string) => ({ id }) as ExecutionApprovalRequest),
    answer: () => Effect.void,
  };
}
function alarmAction(kind: "alarm.arm" | "alarm.fired", id: string, parentId: string, ts: number): LedgerAction.Append {
  return {
    id, parentId, sessionId: "evidence", kind, ts,
    intent: { encodingVersion: 1, value: { phase: "intent", op: kind } },
    effect: { encodingVersion: 1, value: { phase: "result" } },
    irreversible: true,
  };
}
function commitAlarm(fixture: FencedTurnFixture, action: LedgerAction.Append) {
  const kernel = isolatedLedger().kernel;
  return kernel.commit({
    sessionId: "evidence", owner: fixture.owner, fence: fixture.fence, now: action.ts,
    expectedRevision: kernel.row("evidence").revision, state: "running", actions: [action],
  });
}

it("reports armed alarms of this turn and every open intent from obligations and pending approvals", () => isolated(Effect.gen(function* () {
  const kernel = isolatedLedger().kernel;
  const fixture = yield* fencedTurnFixture(kernel, { id: "evidence", clock: () => 0 });
  const evidence = sessionStopEvidence(kernel, "evidence", fixture.turnId, () => approvalsWith(["approval-1"]), () => Effect.succeed([{ actionId: "obligation-1", kind: "message" as const }]));
  yield* commitAlarm(fixture, alarmAction("alarm.arm", "alarm-1", fixture.turnId, 5_000));
  expect(yield* evidence()).toEqual({ progress: true, blocked: false, openIntent: ["obligation-1", "approval-1"], alarmIds: ["alarm-1"] });
})));

it("ignores alarms that are no longer armed and reports nothing when no obligations exist", () => isolated(Effect.gen(function* () {
  const kernel = isolatedLedger().kernel;
  const fixture = yield* fencedTurnFixture(kernel, { id: "evidence", clock: () => 0 });
  const evidence = sessionStopEvidence(kernel, "evidence", fixture.turnId, () => undefined);
  yield* commitAlarm(fixture, alarmAction("alarm.arm", "alarm-1", fixture.turnId, 5_000));
  yield* commitAlarm(fixture, alarmAction("alarm.fired", "alarm-1:fired", "alarm-1", 5_000));
  expect(sessionTree(kernel, "evidence").some((action: LedgerAction.Node) => action.kind === "alarm.arm")).toBe(true);
  expect(yield* evidence()).toEqual({ progress: true, blocked: false, openIntent: [], alarmIds: [] });
})));
