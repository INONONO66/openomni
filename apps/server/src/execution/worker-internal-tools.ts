import type { NativeTool } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { z } from "zod";
import type { WorkerRunState } from "./worker-run-state";

export namespace WorkerInternalTools {
  export const Server = z.custom<{
    call(
      method: "worker.ask_main" | "worker.ask_main_cancel",
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<unknown>;
  }>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "call" in value &&
      typeof value.call === "function",
  );
  export type Server = z.infer<typeof Server>;

  export const ActiveRuns = z.custom<WorkerRunState.InboxReadableActiveRuns>(
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
      labels: ["authority.read", "human-attention", "resident-consult"],
      descriptor: {
        id: "tool:server:ask_main",
        kind: "tool",
        source: { type: "server" },
        labels: ["authority.read", "human-attention", "resident-consult"],
        capabilities: ["resident.consult", "human-attention"],
        effects: ["authority.request"],
        risk: 0,
      },
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: false,
      async execute(call, context) {
        const question = readQuestion(call);
        if (!question) {
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: "ask_main requires a question",
            isError: true,
          };
        }

        if (context?.signal?.aborted) return askMainAbortedResult(call);

        const cancelAskMain = () => {
          void server
            .call(
              "worker.ask_main_cancel",
              {
                authToken: ipcAuthToken,
                workerId,
                sessionId,
                runId,
                callId: call.id,
              },
              5_000,
            )
            .catch(() => undefined);
        };
        context?.signal?.addEventListener("abort", cancelAskMain, { once: true });

        let raw: unknown;
        const abort = abortRace(context?.signal);
        try {
          raw = await Promise.race([
            server.call("worker.ask_main", {
              authToken: ipcAuthToken,
              workerId,
              sessionId,
              runId,
              callId: call.id,
              question,
            }),
            abort.promise,
          ]);
        } catch (error) {
          if (isAbortError(error)) return askMainAbortedResult(call);
          throw error;
        } finally {
          context?.signal?.removeEventListener("abort", cancelAskMain);
          abort.cleanup();
        }
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

function askMainAbortedResult(call: Tool.Call): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: "worker.ask_main aborted",
    isError: true,
  };
}

function createAbortError(): Error {
  const error = new Error("worker.ask_main aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortRace(signal: AbortSignal | undefined): {
  readonly promise: Promise<never>;
  readonly cleanup: () => void;
} {
  if (!signal) {
    return {
      promise: new Promise<never>(() => {
        // The caller did not provide cancellation.
      }),
      cleanup: () => undefined,
    };
  }
  if (signal.aborted)
    return { promise: Promise.reject(createAbortError()), cleanup: () => undefined };
  let cleanup: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cleanup };
}
