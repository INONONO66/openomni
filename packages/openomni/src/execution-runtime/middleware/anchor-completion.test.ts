import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createAnchorCompletion } from "./anchor-completion.js";

/**
 * Owner ruling 2026-08-19: summarization on by default. The completion is a
 * one-shot, tool-less, single-step llm call under the run's own trace with
 * a suffixed runId — attributable, distinguishable, and D7-conformant (the
 * run's own model).
 */
describe("createAnchorCompletion", () => {
  const deps = {
    model: { provider: "anthropic", id: "claude-x" },
    trace: { traceId: "t-anchor", sessionId: "s-anchor", runId: "r-anchor" },
    events: Bus,
    resolveProviderModel: async () => ({ id: "claude-x", provider: "anthropic" }) as never,
  };

  it("runs a one-shot tool-less call under a suffixed runId and returns the text", async () => {
    let seen: { maxSteps?: number; tools?: unknown[]; trace?: { runId: string } } | undefined;
    const complete = createAnchorCompletion({
      ...deps,
      runFn: (async (input: never, sink: { onMessage: (m: Message.WithParts) => void }) => {
        seen = input as never;
        const id = "sum-1";
        sink.onMessage({
          info: {
            id,
            sessionID: "s-anchor",
            role: "assistant",
            time: { created: 1 },
            parentID: "",
            modelID: "claude-x",
            providerID: "anthropic",
            agent: "t",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            { id: "p1", sessionID: "s-anchor", messageID: id, type: "text", text: "merged anchor" },
          ],
        });
        return { type: "stop" };
      }) as never,
    });

    const text = await complete("<conversation>...</conversation>");
    expect(text).toBe("merged anchor");
    expect(seen?.maxSteps).toBe(1);
    expect(seen?.tools).toEqual([]);
    expect(seen?.trace?.runId).toBe("r-anchor:anchor-summary");
  });

  it("throws on an error outcome so the speculator/seam fallback machinery engages", async () => {
    const complete = createAnchorCompletion({
      ...deps,
      runFn: (async () => ({
        type: "error",
        error: { name: "AI_APICallError", message: "provider down", stack: "" },
      })) as never,
    });
    await expect(complete("prompt")).rejects.toThrow("anchor summary failed: provider down");
  });
});
