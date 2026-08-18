import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { anchorSummarizer, serializeSpanForSummary } from "./anchor-summarizer.js";

function assistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  return {
    info: {
      id,
      sessionID: "s",
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: crypto.randomUUID(), sessionID: "s", messageID: id, type: "text", text }],
  };
}

function userMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  return {
    info: {
      id,
      sessionID: "s",
      role: "user",
      time: { created: 1 },
      agent: "test",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: crypto.randomUUID(), sessionID: "s", messageID: id, type: "text", text }],
  };
}

describe("anchorSummarizer", () => {
  it("builds a CREATE prompt on first cut and an UPDATE prompt with the previous anchor after", async () => {
    const prompts: string[] = [];
    const summarize = anchorSummarizer(async (prompt) => {
      prompts.push(prompt);
      return "checkpoint";
    });

    await summarize([assistantMessage("did work")]);
    await summarize([assistantMessage("more work")], "prior checkpoint body");

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("did work");
    expect(prompts[0]).not.toContain("<previous-summary>");
    expect(prompts[1]).toContain("<previous-summary>\nprior checkpoint body\n</previous-summary>");
    expect(prompts[1]).toContain("PRESERVE all information");
    // The sectioned checklist is the whole point — structure forces preservation.
    for (const section of [
      "## Goal",
      "## Constraints & Preferences",
      "## Progress",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
    ]) {
      expect(prompts[0]).toContain(section);
      expect(prompts[1]).toContain(section);
    }
  });

  it("never serializes user text, even if a user message leaks into the span", () => {
    const rendered = serializeSpanForSummary([
      userMessage("SECRET user constraint"),
      assistantMessage("assistant reply"),
    ]);
    expect(rendered).not.toContain("SECRET user constraint");
    expect(rendered).toContain("assistant reply");
  });

  it("renders tool parts with call id and completed output", () => {
    const message = assistantMessage("ignored");
    const withTool: Message.WithParts = {
      ...message,
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: "s",
          messageID: message.info.id,
          type: "tool",
          callID: "call-7",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "tool says hi",
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      ],
    };
    const rendered = serializeSpanForSummary([withTool]);
    expect(rendered).toContain("[tool read call call-7]");
    expect(rendered).toContain("tool says hi");
  });
});
