import type { NativeTool } from "@openomni/openomni";
import { z } from "zod";

export namespace WorkerInternalTools {
  export const Options = z.object({
    readInbox: z.custom<() => string[]>((value) => typeof value === "function"),
  });
  export type Options = z.infer<typeof Options>;

  export function create(options: Options): NativeTool[] {
    const { readInbox } = Options.parse(options);

    const checkInbox: NativeTool = {
      spec: {
        name: "check_inbox",
        description:
          "Fetch live messages delivered by Resident/User while this worker run is active.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      source: "server",
      category: "delegation",
      riskTier: 0,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      async execute(call) {
        const messages = readInbox();
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: JSON.stringify({ messages, count: messages.length }),
        };
      },
    };

    return [checkInbox];
  }
}
