import { Effect } from "effect";
import { ForeignFailure, type ExecutionError } from "./errors";
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import type { PolicyEvaluation } from "@openomni/policy";
import {
  judgeStop,
  type StopState,
  type StopObservation,
  type StopMetric,
} from "./core/execution/stop-chain";
import type { ExecutorOptions } from "./executor-contract";

/** Projects limits from the captured compiler; never repeats policy row names or numeric limits. */
export function createStopJudge(
  options: ExecutorOptions,
  decide: (op: string, value: PlainValue) => Effect.Effect<PolicyEvaluation, ExecutionError>,
  commit: (action: LedgerAction.Append) => Effect.Effect<LedgerAction.Receipt, ExecutionError>,
) {
  return (state: StopState, observation: StopObservation) => Effect.gen(function* () {
    function limit(metric: StopMetric): Effect.Effect<number, ExecutionError> {
      return Effect.gen(function* () {
      const op = metric === "continuation" ? "continue" : metric;
      const decision = yield* decide(op, { metric });
      const rows = decision.obligations.filter(
        (row) => row.name === "budget_clamp" && row.metric === metric,
      );
      const row = rows[0];
      if (
        decision.verdict === "deny" ||
        decision.verdict === "require_approval" ||
        decision.verdict === "transform" ||
        decision.generation !== options.policy.generation ||
        rows.length !== 1 ||
        row === undefined ||
        row.limit <= 0 ||
        !Number.isInteger(row.limit)
      )
        return yield* new ForeignFailure({ operation: "stop.policy", cause: `invalid_stop_policy:${metric}` });
      return row.limit;
      });
    }
    const result = yield* judgeStop(state, observation, limit, () => Effect.gen(function* () {
      const completion = yield* decide("completion", {
        text: observation.text,
        openIntent: [...observation.openIntent],
      });
      return completion.verdict === "allow";
    }));
    yield* commit({
      id: options.entropy(),
      sessionId: options.identity.sessionId,
      parentId: options.identity.parentActionId,
      kind: "turn",
      intent: {
        encodingVersion: 1,
        value: { phase: "stop", generation: options.policy.generation },
      },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "stop",
          verdict:
            result.verdict.kind === "waiting"
              ? { kind: "waiting", reason: "live_wait", alarmIds: [...result.verdict.alarmIds] }
              : { ...result.verdict },
          state: { ...result.state },
        },
      },
      ts: options.clock(),
      irreversible: true,
    });
    return result;
  });
}
