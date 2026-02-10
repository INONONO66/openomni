import { describe, it, expect, beforeAll } from "bun:test";
import { run, type RunInput } from "../../src/run";
import { Auth } from "../../src/auth/storage";
import { listModels } from "../../src/provider/index";
import type { Provider } from "../../src/provider/index";
import type {
  Sink,
  Message,
  ToolCall,
  ToolResult,
  RunSnapshot,
} from "@openomni/protocol";

let auth: Auth.Info | undefined;
let model: Provider.Model | undefined;

beforeAll(async () => {
  auth = await Auth.get("anthropic");
  if (!auth) return;

  const models = await listModels(
    "anthropic",
    auth.type === "oauth" ? "oauth" : "api",
  );
  model = models.find((m) => m.id.includes("haiku")) ?? models[0];
});

function shouldSkip(): boolean {
  return !auth || !model;
}

function createSink() {
  const messages: Message.WithParts[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  const snapshots: RunSnapshot[] = [];

  const sink: Sink = {
    onMessage: (msg) => messages.push(msg),
    onToolCall: (call) => toolCalls.push(call),
    onToolResult: (result) => toolResults.push(result),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  };

  return { sink, messages, toolCalls, toolResults, snapshots };
}

function makeUserMessage(
  text: string,
  sessionID = "test-session",
): Message.WithParts {
  const msgId = crypto.randomUUID();
  return {
    info: {
      id: msgId,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "test",
      model: { providerID: "anthropic", modelID: model?.id ?? "unknown" },
    } as Message.Info,
    parts: [
      {
        id: crypto.randomUUID(),
        sessionID,
        messageID: msgId,
        type: "text" as const,
        text,
      },
    ],
  };
}

const weatherToolSpec = {
  name: "get_weather",
  description: "Get the current weather for a city",
  inputSchema: {
    type: "object" as const,
    properties: {
      city: { type: "string", description: "City name" },
    },
    required: ["city"],
  },
};

const calculateToolSpec = {
  name: "calculate",
  description: "Evaluate a math expression",
  inputSchema: {
    type: "object" as const,
    properties: {
      expression: { type: "string", description: "Math expression" },
    },
    required: ["expression"],
  },
};

describe("Real LLM e2e", () => {
  it("sends a simple prompt and receives text response", async () => {
    if (shouldSkip()) return;

    const { sink, messages } = createSink();

    const input: RunInput = {
      messages: [makeUserMessage("Reply with exactly: PONG")],
      tools: [],
      system: "You are a test assistant. Follow instructions exactly.",
      model: model!,
    };

    const outcome = await run(input, sink);

    expect(outcome.type).toBe("stop");
    expect(messages.length).toBeGreaterThan(0);

    const lastMsg = messages[messages.length - 1];
    const textParts = lastMsg.parts.filter((p) => p.type === "text");
    expect(textParts.length).toBeGreaterThan(0);

    const fullText = textParts.map((p) => ("text" in p ? p.text : "")).join("");
    expect(fullText).toContain("PONG");
  }, 30_000);

  it("streams text incrementally via sink.onMessage", async () => {
    if (shouldSkip()) return;

    const { sink, messages } = createSink();

    const input: RunInput = {
      messages: [makeUserMessage("Write a haiku about testing software.")],
      tools: [],
      system: "You are a poet.",
      model: model!,
    };

    const outcome = await run(input, sink);

    expect(outcome.type).toBe("stop");
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const lastMsg = messages[messages.length - 1];
    const textParts = lastMsg.parts.filter((p) => p.type === "text");
    const fullText = textParts.map((p) => ("text" in p ? p.text : "")).join("");
    expect(fullText.length).toBeGreaterThan(10);
  }, 30_000);

  it("handles abort signal during real LLM call", async () => {
    if (shouldSkip()) return;

    const { sink } = createSink();
    const abortController = new AbortController();

    const input: RunInput = {
      messages: [
        makeUserMessage(
          "Write a very long essay about the history of computing.",
        ),
      ],
      tools: [],
      model: model!,
      signal: abortController.signal,
    };

    setTimeout(() => abortController.abort(), 500);

    const outcome = await run(input, sink);

    expect(["aborted", "error", "stop"]).toContain(outcome.type);
  }, 15_000);

  it("detects tool calls from LLM and returns await_tool", async () => {
    if (shouldSkip()) return;

    const { sink, toolCalls, messages } = createSink();

    const input: RunInput = {
      messages: [
        makeUserMessage(
          "What is the weather in Seoul? Use the get_weather tool.",
        ),
      ],
      tools: [weatherToolSpec],
      system:
        "You have access to tools. When asked about weather, you MUST call the get_weather tool. Do not make up answers.",
      model: model!,
    };

    const outcome = await run(input, sink);

    expect(outcome.type).toBe("await_tool");
    if (outcome.type === "await_tool") {
      expect(outcome.toolCalls.length).toBeGreaterThan(0);
      expect(outcome.toolCalls[0].tool).toBe("get_weather");
      expect(outcome.toolCalls[0].input).toHaveProperty("city");
    }

    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls[0].tool).toBe("get_weather");

    const toolParts = messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool");
    expect(toolParts.length).toBeGreaterThan(0);
  }, 30_000);

  it("completes full tool loop: LLM calls tool, receives result, produces final text", async () => {
    if (shouldSkip()) return;

    const fakeWeather: Record<string, string> = {
      seoul: "Sunny, 3°C",
      tokyo: "Rainy, 7°C",
    };

    let turnCount = 0;
    const maxTurns = 5;
    let allMessages: Message.WithParts[] = [];
    const conversationMessages = [
      makeUserMessage(
        "What is the weather in Seoul? Use the tool then tell me the result.",
      ),
    ];

    let finalText = "";

    while (turnCount < maxTurns) {
      turnCount++;
      const { sink, messages, toolCalls } = createSink();

      const input: RunInput = {
        messages: conversationMessages,
        tools: [weatherToolSpec],
        system:
          "You have access to tools. Use get_weather to check weather. After receiving tool results, summarize them for the user.",
        model: model!,
      };

      const outcome = await run(input, sink);
      allMessages = [...allMessages, ...messages];

      if (outcome.type === "stop") {
        const lastMsg = messages[messages.length - 1];
        const textParts = lastMsg?.parts.filter((p) => p.type === "text") ?? [];
        finalText = textParts.map((p) => ("text" in p ? p.text : "")).join("");
        break;
      }

      if (outcome.type === "await_tool") {
        for (const call of outcome.toolCalls) {
          const city = String(
            (call.input as Record<string, unknown>).city ?? "",
          ).toLowerCase();
          const weather = fakeWeather[city] ?? `Clear, 20°C in ${city}`;

          const toolResultMsg: Message.WithParts = {
            info: {
              id: crypto.randomUUID(),
              sessionID: "test-session",
              role: "assistant",
              time: { created: Date.now() },
              parentID: "",
              modelID: model!.id,
              providerID: model!.providerID,
              agent: "test",
              path: { cwd: process.cwd(), root: process.cwd() },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            } as Message.Info,
            parts: [
              {
                id: crypto.randomUUID(),
                sessionID: "test-session",
                messageID: "",
                type: "tool" as const,
                callID: call.id,
                tool: call.tool,
                state: {
                  status: "completed" as const,
                  input: call.input,
                  output: weather,
                  title: call.tool,
                  metadata: {},
                  time: { start: Date.now(), end: Date.now() },
                },
              },
            ],
          };
          conversationMessages.push(toolResultMsg);
        }
        continue;
      }

      break;
    }

    expect(turnCount).toBeLessThanOrEqual(maxTurns);
    expect(finalText.length).toBeGreaterThan(0);
    expect(
      finalText.toLowerCase().includes("sunny") ||
        finalText.toLowerCase().includes("3") ||
        finalText.toLowerCase().includes("seoul"),
    ).toBe(true);
  }, 60_000);

  it("detects multiple tool calls in a single response", async () => {
    if (shouldSkip()) return;

    const { sink, toolCalls } = createSink();

    const input: RunInput = {
      messages: [
        makeUserMessage(
          "What is the weather in Seoul and also calculate 7 * 8? Use both tools.",
        ),
      ],
      tools: [weatherToolSpec, calculateToolSpec],
      system:
        "You have tools available. ALWAYS use get_weather for weather questions and calculate for math. Call BOTH tools now.",
      model: model!,
    };

    const outcome = await run(input, sink);

    expect(outcome.type).toBe("await_tool");
    if (outcome.type === "await_tool") {
      expect(outcome.toolCalls.length).toBeGreaterThanOrEqual(2);
      const toolNames = outcome.toolCalls.map((tc) => tc.tool).sort();
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("calculate");
    }
  }, 30_000);
});
