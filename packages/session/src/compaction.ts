import { z } from "zod";
import { Storage } from "./storage";
import { BusEvent, Bus } from "./bus";
import { Message } from "@openomni/protocol";

export namespace Compaction {
  export const Event = {
    Compacted: BusEvent.define(
      "compaction.compacted",
      z.object({
        sessionID: z.string(),
        removedTokens: z.number(),
      }),
    ),
  };

  export function isOverflow(input: {
    tokens: { input: number; output: number };
    contextLimit: number;
  }): boolean {
    const totalTokens = input.tokens.input + input.tokens.output;
    return totalTokens > input.contextLimit * 0.8;
  }

  export function prune(input: {
    sessionID: string;
    protectRecent: number;
    onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
  }): number {
    const adapter = Storage.getAdapter();
    const messages = adapter.message.list(input.sessionID);

    if (messages.length <= input.protectRecent) return 0;

    const protectedStart = messages.length - input.protectRecent;
    let removedTokens = 0;

    for (let i = 0; i < protectedStart; i++) {
      const msg = messages[i];
      const parts = adapter.part.list(msg.id);

      for (const part of parts) {
        if (part.type === "tool") {
          const toolPart = part as Message.ToolPart;
          if (toolPart.state.status === "completed") {
            const outputLength = toolPart.state.output.length;
            const estimatedTokens = Math.ceil(outputLength / 4);
            removedTokens += estimatedTokens;

            const compactedPart: Message.ToolPart = {
              ...toolPart,
              state: {
                ...toolPart.state,
                output: "[Compacted]",
              },
            };
            adapter.part.set(msg.id, compactedPart);
          }
        }
      }
    }

    if (removedTokens > 0) {
      Bus.publish(Event.Compacted, {
        sessionID: input.sessionID,
        removedTokens,
      });
    }

    return removedTokens;
  }

  export function reset(): void {
    // No internal state to clear — compaction operates on storage directly
  }
}
