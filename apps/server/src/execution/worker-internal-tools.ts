import type { NativeTool } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { z } from "zod";

export namespace WorkerInternalTools {
  export const InboxRun = z.object({ inbox: z.array(z.string()) });
  export type InboxRun = z.infer<typeof InboxRun>;

  export const Server = z.custom<{
    call(method: "worker.ask_main", params: Record<string, unknown>): Promise<unknown>;
  }>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "call" in value &&
      typeof value.call === "function",
  );
  export type Server = z.infer<typeof Server>;

  export const ActiveRuns = z.custom<Pick<Map<string, InboxRun>, "get">>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "get" in value &&
      typeof value.get === "function",
  );
  export type ActiveRuns = z.infer<typeof ActiveRuns>;

  export const Options = z.object({
    runId: z.string(),
    sessionId: z.string(),
    server: Server,
    ipcAuthToken: z.string(),
    workerId: z.string(),
    activeRuns: ActiveRuns,
  });
  export type Options = z.infer<typeof Options>;

  export function create(options: Options): NativeTool[] {
    const { runId, sessionId, server, ipcAuthToken, workerId, activeRuns } = Options.parse(options);
    const askMain: NativeTool = {
      spec: {
        name: "ask_main",
        description:
          "Ask the Resident for guidance, approval, or missing context. Blocks until Resident answers.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Question or decision request for Resident" },
          },
          required: ["question"],
        },
      },
      source: "server",
      category: "delegation",
      riskTier: 1,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      async execute(call) {
        const question = readQuestion(call);
        if (!question) {
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: "ask_main requires a question",
            isError: true,
          };
        }

        const raw = await server.call("worker.ask_main", {
          authToken: ipcAuthToken,
          workerId,
          sessionId,
          runId,
          question,
        });
        const response =
          raw && typeof raw === "object"
            ? (raw as { accepted?: unknown; output?: unknown; error?: unknown })
            : undefined;
        const accepted = response?.accepted === true;
        const output = accepted
          ? String(response?.output ?? "")
          : String(response?.error ?? "worker.ask_main was rejected");
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output,
          ...(accepted ? {} : { isError: true }),
        };
      },
    };

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
        const active = activeRuns.get(runId);
        const messages = active?.inbox.splice(0) ?? [];
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: JSON.stringify({ messages, count: messages.length }),
        };
      },
    };

    return [askMain, checkInbox];
  }
}

function readQuestion(call: Tool.Call): string {
  if (!call.input || typeof call.input !== "object" || !("question" in call.input)) {
    return "";
  }
  const question = (call.input as { question?: unknown }).question;
  return typeof question === "string" ? question : "";
}
