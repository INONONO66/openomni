import { ChatAgent } from "@openomni/agent";
import type { AgentBudget } from "@openomni/agent";
import type { PlanStep } from "@openomni/protocol";

export const DEFAULT_REVIEW_PROMPT =
  "You are a strict code reviewer evaluating task execution results. " +
  'Always respond with valid JSON containing a "decision" field ' +
  '("accept" or "reject") and an optional "feedback" field.';

export const DEFAULT_HANDOFF_PROMPT =
  "You are an expert at analyzing failed task executions and creating handoff documents. " +
  "Summarize what was attempted, why it failed, and what should be tried differently. " +
  "Respond with a clear, concise handoff document in plain text.";
export namespace ReviewLoop {
  export interface ReviewConfig {
    model: { provider: string; id: string };
    systemPrompt?: string;
    budget?: AgentBudget;
  }

  export interface ReviewInput {
    step: PlanStep;
    result: string;
    agentId: string;
    attemptNumber: number;
  }

  export interface ReviewOutput {
    decision: "accept" | "reject";
    feedback?: string;
    handoffDocument?: string;
  }

  function buildReviewPrompt(input: ReviewInput): string {
    return [
      "You are reviewing the output of a task execution.",
      "",
      `Step: ${input.step.description}`,
      `Expected Output: ${input.step.expectedOutput}`,
      `Guardrail: ${input.step.guardrail ?? "None specified"}`,
      "",
      `Agent: ${input.agentId}`,
      `Attempt: ${input.attemptNumber}`,
      "",
      "Result produced:",
      input.result,
      "",
      "Evaluate whether this result meets the expected output and guardrail criteria.",
      "",
      "Respond with ONLY valid JSON:",
      "{",
      '  "decision": "accept" | "reject",',
      '  "feedback": "<optional explanation>"',
      "}",
    ].join("\n");
  }

  export async function review(input: ReviewInput, config: ReviewConfig): Promise<ReviewOutput> {
    const agent = ChatAgent.create({
      model: config.model,
      systemPrompt: config.systemPrompt ?? DEFAULT_REVIEW_PROMPT,
      budget: config.budget,
    });

    const result = await agent.run({
      messages: [{ role: "user", content: buildReviewPrompt(input) }],
    });

    let parsed: { decision: string; feedback?: string };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new Error(`Failed to parse review response as JSON: ${result.text}`);
    }

    if (parsed.decision !== "accept" && parsed.decision !== "reject") {
      throw new Error(`Invalid review decision: ${parsed.decision}`);
    }

    return {
      decision: parsed.decision as "accept" | "reject",
      feedback: parsed.feedback,
    };
  }

  export function shouldHandoff(attemptNumber: number, maxAttempts: number): boolean {
    return attemptNumber >= maxAttempts - 1;
  }

  export async function generateHandoff(
    input: ReviewInput,
    rejectionFeedback: string,
    config: ReviewConfig,
  ): Promise<string> {
    const agent = ChatAgent.create({
      model: config.model,
      systemPrompt: DEFAULT_HANDOFF_PROMPT,
      budget: config.budget,
    });

    const prompt = [
      "Generate a handoff document for the following failed task execution.",
      "",
      `Step: ${input.step.description}`,
      `Expected Output: ${input.step.expectedOutput}`,
      `Agent: ${input.agentId}`,
      `Attempt: ${input.attemptNumber}`,
      "",
      "Result produced:",
      input.result,
      "",
      "Rejection feedback:",
      rejectionFeedback,
      "",
      "Create a concise handoff document that summarizes:",
      "1. What was attempted",
      "2. Why it was rejected",
      "3. What the next agent should try differently",
    ].join("\n");

    const result = await agent.run({
      messages: [{ role: "user", content: prompt }],
    });

    return result.text;
  }
}
