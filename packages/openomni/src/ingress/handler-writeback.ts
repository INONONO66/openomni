import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision as Decision } from "@openomni/protocol";
import type { HandlerContext } from "./handler-types";
import { resolveTarget } from "./target";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export async function dispatchWritebackCommit(
  ctx: HandlerContext,
  output: string,
): Promise<string> {
  if (!ctx.policies?.length) return output;

  const engine = PolicyEngine.create({
    traceContext: ctx.traceContext,
    onDecision: ctx.onPolicyDecision,
  });
  for (const reg of ctx.policies) {
    engine.register(reg);
  }

  const decision = await engine.dispatch("writeback.commit", {
    steps: [],
    usage: emptyUsage,
    turnCount: 0,
    isCompletion: true,
    continuationCount: 0,
    elapsedMs: 0,
    labels: [
      { value: `surface.${ctx.event.surface}`, source: "system" },
      { value: `target.${resolveTarget(ctx.event).kind}`, source: "system" },
    ],
    toolInput: {
      sessionId: ctx.sessionId,
      mode: ctx.event.mode,
      target: resolveTarget(ctx.event).kind,
      surface: ctx.event.surface,
      output,
    },
    traceContext: ctx.traceContext,
  });

  return resolveWritebackDecision(decision, output);
}

function resolveWritebackDecision(decision: Decision, output: string): string {
  if (Decision.isBlocking(decision)) {
    throw new Error(Decision.reason(decision, "writeback.commit policy denied"));
  }
  const suppress = decision.effects.find((effect) => effect.type === "writeback.suppress");
  if (suppress?.type === "writeback.suppress") {
    throw new Error(suppress.reason ?? "writeback.commit policy suppressed output");
  }
  const rewrite = decision.effects.find((effect) => effect.type === "writeback.rewrite");
  return rewrite?.type === "writeback.rewrite" ? rewrite.output : output;
}
