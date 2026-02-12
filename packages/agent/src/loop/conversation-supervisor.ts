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

import { Message } from "@openomni/protocol";
import { Session } from "@openomni/session";
import {
  resolveAgentDefinition,
  resolveLLM,
  resolveToolExecutor,
} from "./agent-resolution";
import { RunWorker } from "./run-worker";
import type {
  SessionMode,
  OrchestratorConfig,
  OrchestratorRunInput,
  OrchestrationResult,
} from "./run-worker";

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

    // TODO(step 3): Intent classification — immediate vs plan-sized
    // TODO(step 4): Plan generation — generatePlan(session, requirements)

    // TODO(step 5): Approval gate (D11)
    // Plan-sized execution MUST NOT be auto-approved.
    // Present plan → await explicit user approval → reject/revise/approve

    // TODO(step 6): Fork execution context (D10)
    // summarizedHistory = summarizeHistory(session)  // NOT raw transcript
    // fork = createFork(conversationSessionId, summarizedHistory, approvedPlan, traceId)

    // TODO(step 7): Delegate to ExecutionSupervisor.run(fork)
    // ExecutionSupervisor creates its own execution timeline session

    // Suppress unused variable warnings (will be used in later steps)
    void traceId;

    return {
      type: "error",
      error: "ConversationSupervisor.run() is not yet implemented",
    };
  }
}
