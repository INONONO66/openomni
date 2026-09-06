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
  decide: (op: string, value: PlainValue) => Promise<PolicyEvaluation>,
  commit: (action: LedgerAction.Append) => Promise<LedgerAction.Receipt>,
) {
  return async (state: StopState, observation: StopObservation) => {
    async function limit(metric: StopMetric): Promise<number> {
      const op = metric === "continuation" ? "continue" : metric;
      const decision = await decide(op, { metric });
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
        throw new Error(`invalid stop policy: ${metric}`);
      return row.limit;
    }
    const result = await judgeStop(state, observation, limit, async () => {
      const completion = await decide("completion", {
        text: observation.text,
        openIntent: [...observation.openIntent],
      });
      return completion.verdict === "allow";
    });
    await commit({
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
  };
}
