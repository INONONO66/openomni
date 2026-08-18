import { beforeAll, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { decorateAnchorRender, deriveArtifactTable, planDecoration } from "./anchor-render.js";

let sessionId: string;

function storeToolPart(tool: string, path: string | undefined, status = "completed"): void {
  const id = crypto.randomUUID();
  const info: Message.AssistantMessage = {
    id,
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "m",
    providerID: "p",
    agent: "t",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  Session.addMessage(sessionId, info);
  Session.addPart(id, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: id,
    type: "tool",
    callID: crypto.randomUUID(),
    tool,
    state:
      status === "completed"
        ? {
            status: "completed",
            input: path === undefined ? {} : { path },
            output: "ok",
            title: tool,
            metadata: {},
            time: { start: 1, end: 2 },
          }
        : { status: "running", input: path === undefined ? {} : { path }, time: { start: 1 } },
  });
}

function user(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
      agent: "t",
      model: { providerID: "", modelID: "" },
    },
    parts: [{ id: crypto.randomUUID(), sessionID: sessionId, messageID: id, type: "text", text }],
  };
}

function anchorMessage(body: string): Message.WithParts {
  const id = crypto.randomUUID();
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
      agent: "compaction",
      model: { providerID: "", modelID: "" },
    },
    parts: [
      {
        id: crypto.randomUUID(),
        sessionID: sessionId,
        messageID: id,
        type: "text",
        text: `[Conversation Summary]\n${body}`,
        metadata: { compactionAnchor: true, anchorBody: body, keptWindow: [] },
      },
    ],
  };
}

beforeAll(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  sessionId = Session.create({
    traceId: "t-render",
    title: "render",
    model: { providerID: "p", modelID: "m" },
  }).id;
});

describe("deriveArtifactTable", () => {
  it("derives file state mechanically from recorded tool calls", () => {
    storeToolPart("read", "/a.ts");
    storeToolPart("grep.search", "/b.ts");
    storeToolPart("edit", "/a.ts"); // modified wins over read
    storeToolPart("write", "/c.ts");
    storeToolPart("bash", undefined); // no path — ignored
    storeToolPart("read", "/pending.ts", "running"); // non-terminal — ignored

    const table = deriveArtifactTable(sessionId);
    expect(table.modified).toEqual(["/a.ts", "/c.ts"]);
    expect(table.read).toEqual(["/b.ts"]);
    expect(table.truncated).toBe(false);
  });
});

describe("planDecoration + decorateAnchorRender", () => {
  it("quotes budget-dropped user text verbatim and recites the newest surviving goal", () => {
    const dropped = user("오래된 제약: 절대 요약하지 마라 🧭");
    const kept = user("kept question");
    const goal = user("the current goal");
    const before = [dropped, kept, goal];
    const after = [anchorMessage("body"), kept, goal];

    const decoration = planDecoration(sessionId, before, after);
    expect(decoration.droppedQuotes).toEqual(["오래된 제약: 절대 요약하지 마라 🧭"]);
    expect(decoration.droppedBeyondQuoteBudget).toBe(0);
    expect(decoration.goal).toBe("the current goal");

    const render = decorateAnchorRender("[Conversation Summary]\nbody", decoration);
    expect(render.startsWith("[Conversation Summary]\nbody")).toBe(true);
    expect(render).toContain("> 오래된 제약: 절대 요약하지 마라 🧭");
    expect(render).toContain("## Current goal (verbatim, latest user message)\n> the current goal");
    expect(render).toContain("## Files (recorded tool calls, not summarized)");
  });

  it("anchor renders are not user speech: never quoted, never the goal", () => {
    const before = [anchorMessage("old-epoch"), user("real question")];
    const after = [anchorMessage("new-epoch"), user("real question")];
    const decoration = planDecoration(sessionId, before, after);
    expect(decoration.droppedQuotes).toEqual([]);
    expect(decoration.goal).toBe("real question");
  });

  it("caps quotes at the budget and counts the rest — never paraphrases", () => {
    const big = (label: string) => user(`${label} ${"x".repeat(6000)}`);
    const b1 = big("first");
    const b2 = big("second");
    const keep = user("keep");
    const decoration = planDecoration(sessionId, [b1, b2, keep], [keep]);
    // Newest-first under the 8k budget: only the newest big one fits.
    expect(decoration.droppedQuotes).toHaveLength(1);
    expect(decoration.droppedQuotes[0]?.startsWith("second")).toBe(true);
    expect(decoration.droppedBeyondQuoteBudget).toBe(1);
    const render = decorateAnchorRender("r", decoration);
    expect(render).toContain("(1 more not quoted — quote budget)");
  });
});
