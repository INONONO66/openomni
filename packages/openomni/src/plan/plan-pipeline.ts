import type { Gate, Plan } from "@openomni/protocol";
import { PlanAgent } from "./plan-agent.js";

const DEFAULT_MAX_RETRIES = 3;

export namespace PlanPipeline {
  export interface Config {
    generator: PlanAgent.GenerateConfig;
    gates: Gate.Check[];
    maxRetries?: number;
  }

  export interface GateRunResult {
    gateName: string;
    verdict: Gate.Verdict;
  }

  export type RunResult =
    | { ok: true; plan: Plan; attempts: number; gateResults: GateRunResult[] }
    | {
        ok: false;
        lastPlan?: Plan;
        attempts: number;
        gateResults: GateRunResult[];
        reason: string;
      };

  export async function run(goal: string, config: Config): Promise<RunResult> {
    const maxRetries = Math.max(1, config.maxRetries ?? DEFAULT_MAX_RETRIES);
    const gateResults: GateRunResult[] = [];

    let attempt = 1;
    let previousFeedback: string | undefined;
    let lastPlan: Plan | undefined;

    while (attempt <= maxRetries) {
      const enrichedGoal = previousFeedback
        ? `${goal}\n\n[Previous plan was rejected. Address this feedback:\n${previousFeedback}]`
        : goal;
      const planResult = await PlanAgent.generate(
        enrichedGoal,
        config.generator,
      );
      lastPlan = planResult.plan;

      const failedFeedback: string[] = [];
      let hasFailedGate = false;

      for (const gate of config.gates) {
        const verdict = await gate.check(lastPlan, {
          goal,
          attempt,
          previousFeedback,
        });

        gateResults.push({ gateName: gate.name, verdict });

        const hasErrorIssue = verdict.issues.some(
          (issue) => issue.severity === "error",
        );
        const failed = !verdict.passed || hasErrorIssue;

        if (failed && verdict.feedback) {
          failedFeedback.push(verdict.feedback);
        }

        if (failed) {
          hasFailedGate = true;
        }

        if (hasErrorIssue) {
          break;
        }
      }

      if (!hasFailedGate) {
        return {
          ok: true,
          plan: lastPlan,
          attempts: attempt,
          gateResults,
        };
      }

      previousFeedback =
        failedFeedback.length > 0 ? failedFeedback.join("\n") : undefined;
      attempt += 1;
    }

    return {
      ok: false,
      lastPlan,
      attempts: maxRetries,
      gateResults,
      reason: "Max retries exceeded",
    };
  }
}
