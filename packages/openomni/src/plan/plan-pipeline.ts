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
    actions: string[];
  }

  interface ResultBase {
    attempts: number;
    gateResults: GateRunResult[];
    enricherResults?: EnricherRunResult[];
  }
  export type RunResult =
    | (ResultBase & { ok: true; plan: Plan })
    | (ResultBase & { ok: false; lastPlan?: Plan; reason: string });

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
      lastPlan = (await PlanAgent.generate(enrichedGoal, config.generator)).plan;
      if (config.enrichers && config.enrichers.length > 0) {
        for (const enricher of config.enrichers) {
          try {
            const r = await enricher.enrich(lastPlan, { goal, attempt, previousFeedback });
            enricherResults.push({
              enricherName: enricher.name,
              actions: r.applied.map((a) => a.type),
            });
            if (r.applied.length > 0) lastPlan = r.plan;
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
        const verdict = await gate.check(lastPlan, { goal, attempt, previousFeedback });
        gateResults.push({ gateName: gate.name, verdict });
        const hasError = verdict.issues.some((i) => i.severity === "error");
        const failed = !verdict.passed || hasError;
        if (failed && verdict.feedback) failedFeedback.push(verdict.feedback);
        if (failed) hasFailedGate = true;
        if (hasError) break;
      }

      if (!hasFailedGate) {
        const er = enricherResults.length > 0 ? enricherResults : undefined;
        return { ok: true, plan: lastPlan, attempts: attempt, gateResults, enricherResults: er };
      }
      previousFeedback = failedFeedback.length > 0 ? failedFeedback.join("\n") : undefined;
      attempt += 1;
    }
    const er = enricherResults.length > 0 ? enricherResults : undefined;
    return {
      ok: false,
      lastPlan,
      attempts: maxRetries,
      gateResults,
      enricherResults: er,
      reason: "Max retries exceeded",
    };
  }
}
