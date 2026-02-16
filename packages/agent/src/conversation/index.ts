export type Complexity = "trivial" | "simple" | "complex";

export interface RequestContext {
  estimatedDuration: number; // milliseconds
  fileCount: number;
  needsApproval: boolean;
  userIntent: string;
  complexity: Complexity;
}

export interface Decision {
  path: "inline" | "task";
  reason: string;
}

/**
 * ConversationHandler namespace providing utilities for deciding between
 * inline execution and task registration based on request characteristics.
 *
 * Implements heuristics from spec 3.13:
 * - duration < 30s → inline
 * - single file edit → inline
 * - question/lookup → inline
 * - multi-module file writes → task
 * - "later"/"when you have time" → task
 * - needs approval → task
 * - "create PR"/"implement feature" → task
 */
export namespace ConversationHandler {
  /**
   * Decides whether a request should be executed inline or as a background task.
   * Pure deterministic function based on heuristics from spec 3.13.
   *
   * @param request - The request context containing signals for decision
   * @returns Decision with path ("inline" or "task") and reason
   */
  export function decide(request: RequestContext): Decision {
    const {
      estimatedDuration,
      fileCount,
      needsApproval,
      userIntent,
      complexity,
    } = request;

    // Heuristic 1: Needs design review or approval → Task
    if (needsApproval) {
      return {
        path: "task",
        reason: "Needs design review or approval",
      };
    }

    // Heuristic 2: User says "later", "when you have time" → Task
    const deferredKeywords = [
      "later",
      "when you have time",
      "background",
      "eventually",
      "whenever",
    ];
    const intentLower = userIntent.toLowerCase();
    if (deferredKeywords.some((keyword) => intentLower.includes(keyword))) {
      return {
        path: "task",
        reason:
          'User requested deferred execution ("later", "when you have time")',
      };
    }

    // Heuristic 3: "Create PR", "implement feature" → Task
    const taskKeywords = [
      "create pr",
      "implement feature",
      "implement",
      "build",
      "develop",
      "add feature",
    ];
    if (taskKeywords.some((keyword) => intentLower.includes(keyword))) {
      return {
        path: "task",
        reason: 'Complex work request ("create PR", "implement feature")',
      };
    }

    // Heuristic 4: Requires file writes across multiple modules → Task
    if (fileCount > 3) {
      return {
        path: "task",
        reason: "Requires file writes across multiple modules",
      };
    }

    // Heuristic 7: Question or lookup → Inline (high priority)
    const questionKeywords = [
      "what",
      "how",
      "why",
      "when",
      "where",
      "who",
      "?",
      "explain",
      "show",
      "find",
      "search",
      "lookup",
      "check",
    ];
    if (questionKeywords.some((keyword) => intentLower.includes(keyword))) {
      return {
        path: "inline",
        reason: "Question or lookup",
      };
    }

    // Heuristic 6: Single file edit → Inline
    if (fileCount === 1) {
      return {
        path: "inline",
        reason: "Single file edit",
      };
    }

    const INLINE_THRESHOLD_MS = 30000; // 30 seconds

    // Heuristic 5: Estimated duration < 30s AND not complex → Inline
    if (estimatedDuration < INLINE_THRESHOLD_MS && complexity !== "complex") {
      return {
        path: "inline",
        reason: "Estimated duration < 30s",
      };
    }

    // Long-running operation → Task
    if (estimatedDuration >= INLINE_THRESHOLD_MS) {
      return {
        path: "task",
        reason: "Long-running operation (>= 30s)",
      };
    }

    // Complexity-based decision for remaining cases
    if (complexity === "complex") {
      return {
        path: "task",
        reason: "Complex operation requiring checkpoints",
      };
    }

    // Final fallback: inline for simple/trivial
    return {
      path: "inline",
      reason: "Simple operation within conversation response time",
    };
  }
}

// Re-export conversation-supervisor
export {
  ConversationSupervisor,
  type ConversationSupervisorConfig,
  type ConversationInput,
  type ConversationPlan,
  type WorkItemOutline,
  type ApprovalDecision,
  type ExecutionContextFork,
  type ConversationHistory,
  type ConversationSupervisorResult,
} from "./conversation-supervisor";
