import { PlanSchema, type Gate, type Plan } from "@openomni/protocol";
import { PlanAgent } from "./plan-agent.js";

const DEFAULT_MAX_RETRIES = 3;

export namespace PlanPipeline {
  export interface Config {
    generator: PlanAgent.GenerateConfig;
    enrichers?: Gate.Enricher[];
    gates: Gate.Check[];
    maxRetries?: number;
  }

  export interface GateRunResult {
    gateName: string;
    verdict: Gate.Verdict;
  }

  export interface EnricherRunResult {
    enricherName: string;
    action: string;
  }

  export type RunResult =
    | {
        ok: true;
        plan: Plan;
        attempts: number;
        gateResults: GateRunResult[];
        enricherResults?: EnricherRunResult[];
      }
    | {
        ok: false;
        lastPlan?: Plan;
        attempts: number;
        gateResults: GateRunResult[];
        enricherResults?: EnricherRunResult[];
        reason: string;
      };

  export async function run(goal: string, config: Config): Promise<RunResult> {
    const maxRetries = Math.max(1, config.maxRetries ?? DEFAULT_MAX_RETRIES);
    const gateResults: GateRunResult[] = [];
    const enricherResults: EnricherRunResult[] = [];

    let attempt = 1;
    let previousFeedback: string | undefined;
    let lastPlan: Plan | undefined;

    while (attempt <= maxRetries) {
      const enrichedGoal = previousFeedback
        ? `${goal}\n\n[Previous plan was rejected. Address this feedback:\n${previousFeedback}]`
        : goal;
      const planResult = await PlanAgent.generate(enrichedGoal, config.generator);
      lastPlan = planResult.plan;

      if (config.enrichers && config.enrichers.length > 0) {
        for (const enricher of config.enrichers) {
          try {
            const enrichResult = await enricher.enrich(lastPlan, {
              goal,
              attempt,
              previousFeedback,
            });
            enricherResults.push({
              enricherName: enricher.name,
              action: enrichResult.applied.length > 0 ? enrichResult.applied[0].type : "skip",
            });
            if (enrichResult.applied.length > 0) {
              lastPlan = enrichResult.plan;
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
              ok: false,
              lastPlan,
              attempts: attempt,
              gateResults,
              enricherResults,
              reason: `Enricher '${enricher.name}' failed: ${reason}`,
            };
          }
        }

        const revalidation = PlanSchema.safeParse(lastPlan);
        if (!revalidation.success) {
          return {
            ok: false,
            lastPlan,
            attempts: attempt,
            gateResults,
            enricherResults,
            reason: `Plan validation failed after enrichment: ${revalidation.error.message}`,
          };
        }
        lastPlan = revalidation.data;
      }

      const failedFeedback: string[] = [];
      let hasFailedGate = false;

      for (const gate of config.gates) {
        const verdict = await gate.check(lastPlan, {
          goal,
          attempt,
          previousFeedback,
        });

        gateResults.push({ gateName: gate.name, verdict });

        const hasErrorIssue = verdict.issues.some((issue) => issue.severity === "error");
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
          enricherResults: enricherResults.length > 0 ? enricherResults : undefined,
        };
      }

      previousFeedback = failedFeedback.length > 0 ? failedFeedback.join("\n") : undefined;
      attempt += 1;
    }

    return {
      ok: false,
      lastPlan,
      attempts: maxRetries,
      gateResults,
      enricherResults: enricherResults.length > 0 ? enricherResults : undefined,
      reason: "Max retries exceeded",
    };
  }
}
