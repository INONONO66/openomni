import type { Message, Sink } from "@openomni/protocol";
import { Session } from "@openomni/session";

interface ToolPartRef {
  messageID: string;
  partID: string;
  input: Record<string, unknown>;
  startedAt: number;
}

function createSyntheticAssistantMessage(
  sessionID: string,
): Message.AssistantMessage {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sessionID,
    role: "assistant",
    time: {
      created: now,
      completed: now,
    },
    parentID: crypto.randomUUID(),
    modelID: "orchestrator",
    providerID: "agent",
    agent: "orchestrator",
    path: {
      cwd: process.cwd(),
      root: process.cwd(),
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  };
}

function serializeSnapshot(snapshot: {
  id: string;
  timestamp: number;
}): string {
  return `${snapshot.id}:${snapshot.timestamp}`;
}

export function createSessionSink(sessionID: string): Sink {
  const toolRefs = new Map<string, ToolPartRef>();
  let activeMessageID: string | undefined;

  const ensureMessageID = () => {
    if (activeMessageID) {
      return activeMessageID;
    }

    const message = createSyntheticAssistantMessage(sessionID);
    Session.addMessage(sessionID, message);
    activeMessageID = message.id;
    return activeMessageID;
  };

  return {
    onMessage(message) {
      const normalizedInfo: Message.Info = {
        ...message.info,
        sessionID,
      };

      Session.addMessage(sessionID, normalizedInfo);
      activeMessageID = normalizedInfo.id;

      for (const part of message.parts) {
        const normalizedPart: Message.Part = {
          ...part,
          sessionID,
          messageID: normalizedInfo.id,
        };

        Session.addPart(normalizedInfo.id, normalizedPart);

        if (normalizedPart.type === "tool") {
          const startedAt =
            normalizedPart.state.status === "running" ||
            normalizedPart.state.status === "completed" ||
            normalizedPart.state.status === "error"
              ? normalizedPart.state.time.start
              : Date.now();

          toolRefs.set(normalizedPart.callID, {
            messageID: normalizedInfo.id,
            partID: normalizedPart.id,
            input: normalizedPart.state.input,
            startedAt,
          });
        }
      }
    },

    onToolCall(call) {
      if (toolRefs.has(call.id)) {
        return;
      }

      const messageID = ensureMessageID();
      const toolPart: Message.ToolPart = {
        id: crypto.randomUUID(),
        sessionID,
        messageID,
        type: "tool",
        callID: call.id,
        tool: call.tool,
        state: {
          status: "pending",
          input: call.input,
        },
      };

      Session.addPart(messageID, toolPart);

      toolRefs.set(call.id, {
        messageID,
        partID: toolPart.id,
        input: call.input,
        startedAt: Date.now(),
      });
    },

    onToolResult(result) {
      const ref = toolRefs.get(result.toolCallId);
      const messageID = ref?.messageID ?? ensureMessageID();
      const partID = ref?.partID ?? crypto.randomUUID();
      const input = ref?.input ?? {};
      const startedAt = ref?.startedAt ?? Date.now();
      const completedAt = Date.now();

      const toolPart: Message.ToolPart = result.isError
        ? {
            id: partID,
            sessionID,
            messageID,
            type: "tool",
            callID: result.toolCallId,
            tool: "unknown",
            state: {
              status: "error",
              input,
              error: result.output,
              time: {
                start: startedAt,
                end: completedAt,
              },
            },
          }
        : {
            id: partID,
            sessionID,
            messageID,
            type: "tool",
            callID: result.toolCallId,
            tool: "unknown",
            state: {
              status: "completed",
              input,
              output: result.output,
              title: result.id,
              metadata: {},
              time: {
                start: startedAt,
                end: completedAt,
              },
            },
          };

      if (ref) {
        Session.addPart(messageID, toolPart);
      } else {
        Session.addPart(messageID, toolPart);
      }

      toolRefs.delete(result.toolCallId);
    },

    onSnapshot(snapshot) {
      const messageID = ensureMessageID();
      const part: Message.SnapshotPart = {
        id: crypto.randomUUID(),
        sessionID,
        messageID,
        type: "snapshot",
        snapshot: serializeSnapshot({
          id: snapshot.id,
          timestamp: snapshot.timestamp,
        }),
      };
      Session.addPart(messageID, part);
    },
  };
}
