import type { Message } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { defineTool, errorResult, fromError, requireString, successResult } from "../define.js";

/**
 * Resolves a compaction elision marker back to the recorded original
 * (compaction-design L1). Compaction rewrites only the in-run history via
 * `run.replace_messages`; for fact-recorded worker turns the session store
 * keeps the part as it was recorded at tool completion, so recall is a
 * read, never a re-execution.
 *
 * Recording coverage (transcript.ts writer census): resident direct runs
 * and child-agent streams persist no tool parts — on those paths recall
 * answers "not recorded", loudly, rather than returning anything wrong.
 *
 * Scope: the tool reads exactly the run's own session — `sessionId` is an
 * executor-owned implicit slot (override-or-strip, never pass-through), so
 * a model cannot point it at another session's outputs. Duplicate callIDs
 * (providers mint per-turn ids like call_0 that can repeat across turns)
 * are refused rather than guessed: returning the oldest match's bytes for
 * a newer call's marker would be byte-exact and wrong.
 */
export function createRecallTool() {
  return defineTool<{ callId: string; sessionId?: string }>({
    name: "recall.output",
    description:
      "Recall the full original output of a compaction-elided tool call in this session by its call id",
    prompt: RECALL_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        callId: {
          type: "string",
          description:
            "The call id carried by an elision marker of the form [output elided by compaction: N chars; recall: <callId>]",
        },
      },
      required: ["callId"],
    },
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    riskTier: 0,
    implicitInputs: { sessionId: "sessionId" },
    async execute(call) {
      try {
        const callId = requireString(call.input, "callId");
        const input = call.input as Record<string, unknown>;
        const sessionId =
          typeof input.sessionId === "string" && input.sessionId.length > 0
            ? input.sessionId
            : undefined;
        if (sessionId === undefined) {
          // The executor injects sessionId from its runtime context; reaching
          // this branch means the tool ran outside a session-bound executor,
          // where cross-session reads would be unscoped. Refuse loudly.
          return errorResult(
            call,
            "recall.output requires a session-bound executor runtime — no sessionId was injected",
          );
        }
        const matches: Message.ToolPart[] = [];
        for (const message of Session.getMessages(sessionId)) {
          for (const part of Session.getParts(message.id)) {
            if (part.type !== "tool" || part.callID !== callId) continue;
            matches.push(part);
          }
        }
        if (matches.length === 0) {
          return errorResult(call, `no tool call ${callId} is recorded in this session`);
        }
        if (matches.length > 1) {
          return errorResult(
            call,
            `ambiguous callId ${callId}: ${matches.length} recorded tool calls share this id — refusing to guess which output the marker meant`,
          );
        }
        const part = matches[0];
        if (part === undefined || part.state.status !== "completed") {
          return errorResult(
            call,
            `tool call ${callId} is recorded with status "${part?.state.status ?? "unknown"}" — only completed outputs can be recalled`,
          );
        }
        return successResult(call, part.state.output);
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

const RECALL_PROMPT = `Recall the original output of a tool call whose output was elided by compaction.
Elided outputs appear in the conversation as markers of the form:
[output elided by compaction: N chars; recall: <callId>]
followed by a short head excerpt. Pass that callId to get the complete original output back, byte-exact, without re-running the tool. Only tool calls recorded in the current session can be recalled.`;
