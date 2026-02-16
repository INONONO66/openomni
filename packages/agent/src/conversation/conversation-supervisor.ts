/**
 * ConversationSupervisor — User-facing supervisor for the primary conversation timeline.
 *
 * ## Responsibility Boundary
 *
 * - ConversationSupervisor: requirement gathering, clarification, plan authoring, user approval gate.
 *   Runs on the PRIMARY conversation timeline. All external inbound events enter here first (D9).
 *
 * - ExecutionSupervisor: task decomposition, assignment, accept/reject, re-dispatch loop.
 *   Runs on a DEDICATED execution timeline. Internal-only — never receives direct external events.
 *   Created by ConversationSupervisor after plan approval via execution context fork (D10).
 *
 * - RunWorker: LLM/tool execution loop, retry, budget, session lifecycle, state transitions.
 *   Shared execution primitive used by both supervisor flows.
 *
 * ## Key Invariants
 *
 * 1. External events → ConversationSupervisor ONLY (D9)
 * 2. Plan-sized work requires explicit user approval — no auto-approval (D11)
 * 3. ExecutionSupervisor receives summarized history + approved plan, NOT raw transcript (D10)
 * 4. Session mode: `reuse` when conversation session exists, otherwise `persistent`
 *
 * @see docs/migration-notes/dynamic-supervisor-plan.md — D8, D9, D10, D11
 */

import { z } from "zod";
import { Message } from "@openomni/protocol";
import { Session } from "@openomni/session";
import {
  resolveAgentDefinition,
  resolveLLM,
  resolveToolExecutor,
} from "../worker";
import { BuiltinAgentRegistry } from "../agent";
import { RunWorker } from "../worker";
import type {
  SessionMode,
  OrchestratorConfig,
  OrchestratorRunInput,
  OrchestrationResult,
} from "../worker";

export interface ConversationSupervisorConfig {
  /** Surface-specific readable session key (per D2) */
  conversationSessionId: string;

  /**
   * `reuse` preferred when session exists, else `persistent`.
   * Ephemeral is NOT valid for ConversationSupervisor.
   */
  sessionMode?: Extract<SessionMode, "reuse" | "persistent">;

  agentId?: string;
  traceId?: string;
}

export interface ConversationInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationPlan {
  planId: string;
  title: string;
  description: string;
  workItems: WorkItemOutline[];
  estimatedRuntimeMs?: number;
  createdAt: number;
}

export interface WorkItemOutline {
  description: string;
  effort: "trivial" | "small" | "medium" | "large";
  dependsOn?: number[];
  suggestedAgent?: string;
}

export type ApprovalDecision =
  | { status: "approved" }
  | { status: "rejected"; reason?: string }
  | { status: "revised"; feedback: string };

/**
 * Fork package: ConversationSupervisor → ExecutionSupervisor.
 * Contains SUMMARIZED history only — never raw transcript (D10).
 */
export interface ExecutionContextFork {
  /** Distilled requirements/context — NOT raw transcript */
  summarizedHistory: ConversationHistory;
  approvedPlan: ConversationPlan;
  conversationSessionId: string;
  traceId: string;
  forkedAt: number;
}

export interface ConversationHistory {
  requirements: string[];
  constraints: string[];
  clarifications: string[];
  contextSummary: string;
}

// ============================================================
// Tool Schemas
// ============================================================

/**
 * classify_intent tool schema — LLM uses this to classify user intent.
 * This is a schema-only tool (no executor) — LLM generates the tool call,
 * ConversationSupervisor detects it and branches accordingly.
 */
export const ClassifyIntentInput = z.object({
  intent: z
    .enum(["immediate", "plan_needed"])
    .describe(
      "User intent classification: 'immediate' for simple queries/tasks that can be answered directly, 'plan_needed' for complex work requiring decomposition and approval",
    ),
  reasoning: z
    .string()
    .optional()
    .describe("Brief reasoning for the classification"),
});
export type ClassifyIntentInput = z.infer<typeof ClassifyIntentInput>;

/**
 * generate_plan tool schema — LLM uses this to produce a structured plan.
 * Schema-only tool (no executor) — LLM generates the tool call,
 * ConversationSupervisor extracts and validates the plan.
 */
export const GeneratePlanInput = z.object({
  title: z.string().describe("Plan title"),
  description: z.string().describe("Plan description"),
  workItems: z
    .array(
      z.object({
        description: z.string().describe("Work item description"),
        effort: z
          .enum(["trivial", "small", "medium", "large"])
          .describe("Effort estimate"),
        dependsOn: z
          .array(z.number())
          .optional()
          .describe("Indices of dependent work items"),
        suggestedAgent: z
          .string()
          .optional()
          .describe("Recommended agent for this work item"),
      }),
    )
    .describe("Array of work items"),
  estimatedRuntimeMs: z
    .number()
    .optional()
    .describe("Estimated total runtime in milliseconds"),
});
export type GeneratePlanInput = z.infer<typeof GeneratePlanInput>;

export type ConversationSupervisorResult =
  | { type: "immediate"; response: string }
  | { type: "plan_pending"; plan: ConversationPlan }
  | { type: "execution_forked"; fork: ExecutionContextFork }
  | { type: "ended"; reason: string }
  | { type: "error"; error: string };

export namespace ConversationSupervisor {
  export function resolveSessionMode(
    config: ConversationSupervisorConfig,
    sessionExists: boolean,
  ): Extract<SessionMode, "reuse" | "persistent"> {
    if (config.sessionMode) {
      return config.sessionMode;
    }
    return sessionExists ? "reuse" : "persistent";
  }

  /**
   * Plan-sized work requires explicit user approval (D11) — no auto-approval.
   */
  export function requiresApproval(plan: ConversationPlan): boolean {
    return plan.workItems.length > 0;
  }

  /**
   * Create fork for ExecutionSupervisor handoff — summarized history only, never raw transcript (D10).
   */
  export function createFork(
    conversationSessionId: string,
    summarizedHistory: ConversationHistory,
    approvedPlan: ConversationPlan,
    traceId: string,
  ): ExecutionContextFork {
    return {
      summarizedHistory,
      approvedPlan,
      conversationSessionId,
      traceId,
      forkedAt: Date.now(),
    };
  }

  export async function run(
    config: ConversationSupervisorConfig,
    _input: ConversationInput,
  ): Promise<ConversationSupervisorResult> {
    // Step 1: Session resolution + agent resolution
    const traceId = config.traceId ?? crypto.randomUUID();

    // config.conversationSessionId is session.id (UUID) from SessionResolver
    let session = Session.get(config.conversationSessionId);
    let sessionMode: Extract<SessionMode, "reuse" | "persistent">;

    if (session) {
      // Session exists — reuse
      sessionMode = resolveSessionMode(config, true);
    } else {
      // Session doesn't exist — create new (should rarely happen in practice)
      session = Session.create({
        title: "Conversation Session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
      });
      sessionMode = resolveSessionMode(config, false);
    }

    // Resolve agent definition
    const agentId = config.agentId ?? "conversation-supervisor";
    const agentDef = resolveAgentDefinition(agentId);

    const systemPrompt =
      agentDef?.systemPrompt ??
      "You are a conversation supervisor helping users plan and execute tasks.";
    const tools = agentDef?.tools ?? [];

    const taskId = _input.metadata?.taskId as string | undefined;
    const runId = _input.metadata?.runId as string | undefined;

    if (!taskId || !runId) {
      return {
        type: "error",
        error: "Missing taskId or runId in input.metadata",
      };
    }

    const orchestratorConfig: OrchestratorConfig = {
      taskId,
      runId,
      maxRetries: 0,
      sessionMode,
      sessionId: session.id,
    };

    const userMessage: Message.UserMessage = {
      id: crypto.randomUUID(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: agentId,
      model: session.model,
    };
    Session.addMessage(session.id, userMessage);

    const textPart: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: session.id,
      messageID: userMessage.id,
      type: "text",
      text: _input.content,
    };
    Session.addPart(userMessage.id, textPart);

    const llm = await resolveLLM(agentDef?.model);

    const messageInfos = Session.getMessages(session.id);
    const messagesWithParts: Message.WithParts[] = messageInfos.map((info) => ({
      info,
      parts: Session.getParts(info.id),
    }));

    const runWorkerInput: OrchestratorRunInput = {
      llm,
      input: {
        system: systemPrompt,
        messages: messagesWithParts,
      },
      toolExecutor: resolveToolExecutor(tools),
    };

    const orchestrationResult: OrchestrationResult = await RunWorker.run(
      orchestratorConfig,
      runWorkerInput,
    );

    if (!orchestrationResult.success) {
      return {
        type: "error",
        error: `LLM conversation turn failed: ${orchestrationResult.error}`,
      };
    }

    const messages = Session.getMessages(session.id);
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "assistant") {
      return {
        type: "error",
        error: "No assistant response found after LLM turn",
      };
    }

    const parts = Session.getParts(lastMessage.id);
    const toolParts = parts.filter(
      (part): part is Message.ToolPart => part.type === "tool",
    );

    const classifyIntentCall = toolParts.find(
      (part) => part.tool === "classify_intent",
    );

    if (classifyIntentCall) {
      const input = classifyIntentCall.state.input as ClassifyIntentInput;

      if (input.intent === "immediate") {
        const textParts = parts.filter(
          (part): part is Message.TextPart => part.type === "text",
        );
        const response = textParts.map((p) => p.text).join("");

        return {
          type: "immediate",
          response,
        };
      }
    } else {
      const textParts = parts.filter(
        (part): part is Message.TextPart => part.type === "text",
      );
      const response = textParts.map((p) => p.text).join("");

      if (response) {
        return {
          type: "immediate",
          response,
        };
      }
    }

    const availableAgents = BuiltinAgentRegistry.list();
    const agentSummary = availableAgents
      .map((agent) => `- ${agent.name}: ${agent.description}`)
      .join("\n");

    const planningSystemPrompt = `${systemPrompt}

Available agents for task execution:
${agentSummary}

When generating a plan, assign a suggestedAgent to each work item based on the agent's capabilities.`;

    const planningMessages = Session.getMessages(session.id).map((info) => ({
      info,
      parts: Session.getParts(info.id),
    }));

    const planningInput: OrchestratorRunInput = {
      llm,
      input: {
        system: planningSystemPrompt,
        messages: planningMessages,
      },
      toolExecutor: resolveToolExecutor(tools),
    };

    const planningResult: OrchestrationResult = await RunWorker.run(
      orchestratorConfig,
      planningInput,
    );

    if (!planningResult.success) {
      return {
        type: "error",
        error: `Plan generation failed: ${planningResult.error}`,
      };
    }

    const planMessages = Session.getMessages(session.id);
    const lastPlanMessage = planMessages[planMessages.length - 1];

    if (!lastPlanMessage || lastPlanMessage.role !== "assistant") {
      return {
        type: "error",
        error: "No assistant response found after plan generation turn",
      };
    }

    const planParts = Session.getParts(lastPlanMessage.id);
    const planToolParts = planParts.filter(
      (part): part is Message.ToolPart => part.type === "tool",
    );

    const generatePlanCall = planToolParts.find(
      (part) => part.tool === "generate_plan",
    );

    if (!generatePlanCall) {
      return {
        type: "error",
        error: "LLM did not generate a plan (no generate_plan tool call found)",
      };
    }

    const planInputResult = GeneratePlanInput.safeParse(
      generatePlanCall.state.input,
    );
    if (!planInputResult.success) {
      return {
        type: "error",
        error: `Invalid plan input from LLM: ${planInputResult.error.message}`,
      };
    }

    const planInput = planInputResult.data;

    const plan: ConversationPlan = {
      planId: crypto.randomUUID(),
      title: planInput.title,
      description: planInput.description,
      workItems: planInput.workItems,
      estimatedRuntimeMs: planInput.estimatedRuntimeMs,
      createdAt: Date.now(),
    };

    const agentNames = new Set(availableAgents.map((a) => a.name));
    for (const item of plan.workItems) {
      if (item.suggestedAgent && !agentNames.has(item.suggestedAgent)) {
        console.warn(
          `[ConversationSupervisor] Invalid suggestedAgent: ${item.suggestedAgent}`,
        );
      }
    }

    // Step 5: Approval gate (D11)
    // Plan is returned to caller for user approval.
    // External system (e.g., CLI, UI) presents plan to user and waits for decision:
    // - approved → caller proceeds to Step 6 (fork + ExecutionSupervisor delegation)
    // - rejected → caller handles rejection (no further action)
    // - revised → caller re-invokes ConversationSupervisor with feedback
    //
    // ConversationSupervisor does NOT implement approval logic itself —
    // it returns plan_pending and delegates approval to the caller.
    //
    // This ensures plan-sized work NEVER auto-approves (D11 compliance).

    // Step 6-7: Fork + ExecutionSupervisor delegation
    // These steps are handled by the CALLER (e.g., DefaultRunExecutor), not ConversationSupervisor.
    //
    // Architecture flow:
    // 1. ConversationSupervisor returns { type: "plan_pending", plan }
    // 2. External system (CLI/UI) presents plan to user and waits for approval
    // 3. On approval, external system creates ExecutionContextFork:
    //    - summarizedHistory = summarizeHistory(session)  // NOT raw transcript (D10)
    //    - fork = createFork(conversationSessionId, summarizedHistory, approvedPlan, traceId)
    // 4. External system returns { type: "execution_forked", fork }
    // 5. Caller (e.g., DefaultRunExecutor) delegates to ExecutionSupervisor.run(fork)
    //
    // ConversationSupervisor does NOT implement fork/delegation itself —
    // it provides helper functions (createFork, requiresApproval) for callers to use.
    //
    // See: packages/agent/src/ingress/run-executor.ts:211-240 for reference implementation.

    void traceId;

    return {
      type: "plan_pending",
      plan,
    };
  }
}
