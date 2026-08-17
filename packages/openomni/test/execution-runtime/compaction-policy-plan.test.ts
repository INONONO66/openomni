import { describe, expect, it } from "bun:test";
import type { Message, Policy } from "@openomni/protocol";
import { PolicyRegistry } from "@openomni/agent";
import type { PolicyContext, PolicyFn } from "@openomni/agent";
import { Bus } from "@openomni/telemetry";
import { registerCompaction } from "../../src/execution-runtime/middleware/compaction-policy";

// #546 review F5: production configs never pass WorkerMiddlewareConfig.compaction,
// but the plan registry registers builtin:compaction (registerCompaction, since
// the registration moved here from agent's defaultRegistry), so an external
// PolicyPlan can activate compaction anyway. This suite proves the commit
// boundary invariant holds on that backdoor path over tool-bearing history.

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeUserMessage(text: string): Message.WithParts {
  const id = nextId("user-message");
  const sessionID = "plan-session";
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "test",
      model: { providerID: "", modelID: "" },
    },
    parts: [{ id: nextId("user-part"), sessionID, messageID: id, type: "text", text }],
  };
}

function makeAssistantMessage(text: string, options?: { toolCallID?: string }): Message.WithParts {
  const id = nextId("assistant-message");
  const sessionID = "plan-session";
  const parts: Message.Part[] = [
    { id: nextId("assistant-part"), sessionID, messageID: id, type: "text", text },
  ];
  if (options?.toolCallID !== undefined) {
    parts.push({
      id: nextId("tool-part"),
      sessionID,
      messageID: id,
      type: "tool",
      callID: options.toolCallID,
      tool: "read_file",
      state: {
        status: "completed",
        input: { path: "/tmp/a" },
        output: "file contents",
        title: "read_file",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
  }
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "",
      providerID: "",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

function baseCtx(overrides?: Partial<Parameters<PolicyFn>[0]>): Parameters<PolicyFn>[0] {
  return {
    timing: "turn.finish",
    pointId: "run.completion.pre",
    traceContext: { traceId: "trace-builtin-test" },
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("policyPlan-activated compaction (builtin:compaction backdoor)", () => {
  it("enforces the commit boundary invariant over tool-bearing history", async () => {
    const plan: Policy.PolicyPlan = {
      policies: [
        {
          id: "builtin:compaction",
          required: true,
          // onSummarize is not expressible through a serialized plan config,
          // so the no-summary boundary hazard is the default on this path.
          config: { contextWindowTokens: 1000, thresholdRatio: 0.8, protectRecentMessages: 3 },
        },
      ],
      labels: [],
    };
    const registry = PolicyRegistry.create<PolicyContext>();
    registerCompaction(registry, Bus);
    const registrations = registry.resolve(plan, {});
    const registration = registrations[0];
    if (registration === undefined || registration.kind !== "point") {
      throw new Error("expected canonical builtin:compaction registration");
    }

    // Natural cutoff (length - protectRecent = 5) lands on the tool-bearing
    // assistant message: the invariant must produce a user-led kept window.
    const messages = [
      makeUserMessage("u0"),
      makeAssistantMessage("a1"),
      makeUserMessage("u2"),
      makeAssistantMessage("a3"),
      makeUserMessage("u4"),
      makeAssistantMessage("a5", { toolCallID: "call-1" }),
      makeUserMessage("u6"),
      makeAssistantMessage("a7"),
    ];
    const ctx = baseCtx({ messages, contextTokens: 900 });

    const verdict = await registration.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    const replacement = verdict.effects.find(
      (effect): effect is Extract<typeof effect, { type: "run.replace_messages" }> =>
        effect.type === "run.replace_messages",
    );
    expect(replacement).toBeDefined();
    // The effect carries `messages` as `unknown[]` — it crosses the wire, and
    // the schema will not vouch for a shape it does not own. Here the producer
    // is the compaction builtin two lines up.
    const replaced = (replacement?.messages ?? []) as Message.WithParts[];
    expect(replaced.length).toBeLessThan(messages.length);
    expect(replaced[0]?.info.role).toBe("user");
    // The tool call and its result live inside the same kept WithParts
    // message, so the committed window still carries the intact pair.
    const toolParts = replaced.flatMap((message) =>
      message.parts.filter((part): part is Message.ToolPart => part.type === "tool"),
    );
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]?.callID).toBe("call-1");
    expect(toolParts[0]?.state.status).toBe("completed");
  });
});
