import { Message, PlanSchema } from "@openomni/protocol";
import type { Plan, PlanResult } from "@openomni/protocol";
import { Session } from "@openomni/session";
import type { TeamOrchestrator } from "../team/team-orchestrator";

const PLAN_PREFIX = "__OPENOMNI_PLAN__";

/**
 * Normalize Plan payload from JSON round-trip.
 * JSON.stringify converts Date → string, so we convert it back.
 * Duplicated from plan-agent.ts (private function) to avoid modifying that module.
 */
function normalizePlanPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.createdAt !== "string") {
    return payload;
  }

  const parsedDate = new Date(candidate.createdAt);
  if (Number.isNaN(parsedDate.getTime())) {
    return payload;
  }

  return { ...candidate, createdAt: parsedDate };
}

function createAssistantMessage(
  sessionId: string,
  model: { provider: string; id: string },
): Message.AssistantMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: model.id,
    providerID: model.provider,
    agent: "session-bridge",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

/**
 * SessionBridge — converts between session messages and agent inputs/outputs.
 *
 * Handles Plan storage/extraction using the `__OPENOMNI_PLAN__` prefix convention,
 * and message format conversion for direct/plan/team modes.
 */
export namespace SessionBridge {
  /**
   * Build a goal string for PlanAgent from session messages.
   * - If no previous Plan exists: returns the latest user message text.
   * - If a previous Plan exists: returns "Previous plan:\n{plan}\n\nUser feedback:\n{latest user text}".
   */
  export function buildPlanGoal(sessionId: string): string {
    const messages = Session.getMessages(sessionId);

    // Scan for the last plan in session
    let lastPlanJson: string | undefined;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const parts = Session.getParts(message.id);
      for (const part of parts) {
        if (part.type === "text" && part.text.startsWith(PLAN_PREFIX)) {
          lastPlanJson = part.text.slice(PLAN_PREFIX.length);
        }
      }
    }

    // Get the latest user message text
    let latestUserText = "";
    for (const message of messages) {
      if (message.role === "user") {
        const parts = Session.getParts(message.id);
        for (const part of parts) {
          if (part.type === "text") {
            latestUserText = part.text;
          }
        }
      }
    }

    if (!lastPlanJson) {
      return latestUserText;
    }

    return `Previous plan:\n${lastPlanJson}\n\nUser feedback:\n${latestUserText}`;
  }

  /**
   * Extract the latest Plan from session messages.
   * Scans all TextParts for the `__OPENOMNI_PLAN__` prefix, takes the last one,
   * parses and validates via PlanSchema with Date normalization.
   *
   * @throws Error if no plan found in session
   */
  export function extractPlan(sessionId: string): Plan {
    const messages = Session.getMessages(sessionId);

    let lastPlanText: string | undefined;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const parts = Session.getParts(message.id);
      for (const part of parts) {
        if (part.type === "text" && part.text.startsWith(PLAN_PREFIX)) {
          lastPlanText = part.text.slice(PLAN_PREFIX.length);
        }
      }
    }

    if (!lastPlanText) {
      throw new Error("No plan found in session");
    }

    const parsed = JSON.parse(lastPlanText);
    const normalized = normalizePlanPayload(parsed);
    return PlanSchema.parse(normalized);
  }

  /**
   * Build a simple message array for ChatAgent.run() from session messages.
   * Each message with a TextPart becomes { role, content }.
   */
  export function buildDirectMessages(sessionId: string): Array<{ role: string; content: string }> {
    const messages = Session.getMessages(sessionId);
    const result: Array<{ role: string; content: string }> = [];

    for (const message of messages) {
      const parts = Session.getParts(message.id);
      for (const part of parts) {
        if (part.type === "text" && !part.text.startsWith(PLAN_PREFIX)) {
          result.push({ role: message.role, content: part.text });
        }
      }
    }

    return result;
  }

  /**
   * Store a PlanResult in the session as an AssistantMessage + TextPart
   * with the `__OPENOMNI_PLAN__` prefix for later extraction.
   */
  export function storePlanResult(
    sessionId: string,
    result: PlanResult,
    model: { provider: string; id: string },
  ): void {
    const message = createAssistantMessage(sessionId, model);
    Session.addMessage(sessionId, message);

    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: PLAN_PREFIX + JSON.stringify(result.plan),
    };
    Session.addPart(message.id, part);
  }

  /**
   * Store a TeamResult in the session as an AssistantMessage + TextPart.
   * Converts Map fields to plain objects for JSON serialization.
   */
  export function storeTeamResult(
    sessionId: string,
    result: TeamOrchestrator.TeamResult,
    model: { provider: string; id: string },
  ): void {
    const message = createAssistantMessage(sessionId, model);
    Session.addMessage(sessionId, message);

    const serializable = {
      ...result,
      results: Object.fromEntries(result.results),
    };

    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: JSON.stringify(serializable),
    };
    Session.addPart(message.id, part);
  }

  /**
   * Store a direct agent text output in the session as an AssistantMessage + TextPart.
   */
  export function storeDirectResult(
    sessionId: string,
    output: string,
    model: { provider: string; id: string },
  ): void {
    const message = createAssistantMessage(sessionId, model);
    Session.addMessage(sessionId, message);

    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: output,
    };
    Session.addPart(message.id, part);
  }
}
