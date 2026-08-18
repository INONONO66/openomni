import { Session } from "@openomni/session";
import { defineTool, errorResult, fromError, requireString, successResult } from "../define.js";

/**
 * Resolves a compaction elision marker back to the recorded original
 * (compaction-design L1). Compaction rewrites only the in-run history via
 * `run.replace_messages`; the session store keeps the part as it was
 * recorded at tool completion, so recall is a read, never a re-execution.
 *
 * Scope: the tool reads exactly the run's own session — `sessionId` arrives
 * as an executor-injected implicit input, so a model cannot point it at
 * another session's outputs.
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
        for (const message of Session.getMessages(sessionId)) {
          for (const part of Session.getParts(message.id)) {
            if (part.type !== "tool" || part.callID !== callId) continue;
            if (part.state.status !== "completed") {
              return errorResult(
                call,
                `tool call ${callId} is recorded with status "${part.state.status}" — only completed outputs can be recalled`,
              );
            }
            return successResult(call, part.state.output);
          }
        }
        return errorResult(call, `no tool call ${callId} is recorded in this session`);
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
