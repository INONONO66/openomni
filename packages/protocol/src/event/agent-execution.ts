import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Token } from "../token/index.js";

const AgentBase = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  time: z.number(),
});

export namespace AgentExecution {
  export const TurnStart = BusEvent.define(
    "agent.turn.start",
    AgentBase.extend({
      turnIndex: z.number(),
    }),
    { visibility: "ephemeral" },
  );

  export const TurnComplete = BusEvent.define(
    "agent.turn.complete",
    AgentBase.extend({
      turnIndex: z.number(),
      usage: Token.AgentUsage,
    }),
    { visibility: "llm_reason" },
  );

  export const BudgetWarning = BusEvent.define(
    "agent.budget.warning",
    AgentBase.extend({
      remaining: z.string(),
      threshold: z.number(),
    }),
    { visibility: "llm_reason" },
  );

  export const BudgetReassurance = BusEvent.define(
    "agent.budget.reassurance",
    AgentBase.extend({
      remaining: z.string(),
      threshold: z.number(),
    }),
    { visibility: "ephemeral" },
  );

  export const Compaction = BusEvent.define(
    "agent.compaction",
    AgentBase.extend({
      messagesBefore: z.number(),
      messagesAfter: z.number(),
    }),
    { visibility: "llm_reason" },
  );

  export const ErrorRetry = BusEvent.define(
    "agent.error.retry",
    AgentBase.extend({
      attempt: z.number(),
      maxAttempts: z.number(),
      error: z.string(),
    }),
    { visibility: "llm_reason" },
  );
}
