import { beforeAll, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import {
  contentChars,
  decorateAnchorRender,
  deriveArtifactTable,
  planDecoration,
} from "./anchor-render.js";

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

function assistantText(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "t",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
  const bulk = assistantText(`old work ${"x".repeat(15000)}`);

  it("quotes budget-dropped user text verbatim and recites the newest surviving goal", () => {
    const dropped = user("오래된 제약: 절대 요약하지 마라 🧭");
    const kept = user("kept question");
    const goal = user("the current goal");
    const before = [dropped, bulk, kept, goal];
    const after = [anchorMessage("body"), kept, goal];

    const decoration = planDecoration(sessionId, before, after);
    if (decoration === undefined) throw new Error("expected decoration");
    expect(decoration.droppedQuotes).toEqual(["오래된 제약: 절대 요약하지 마라 🧭"]);
    expect(decoration.droppedBeyondQuoteBudget).toBe(0);
    expect(decoration.goal).toBe("the current goal");

    const render = decorateAnchorRender("[Conversation Summary]\nbody", decoration);
    expect(render.startsWith("[Conversation Summary]\nbody")).toBe(true);
    expect(render).toContain("> 오래된 제약: 절대 요약하지 마라 🧭");
    expect(render).toContain(
      "## Current goal (latest user message; full text is in the window)\n> the current goal",
    );
    expect(render).toContain("## Files (recorded builtin file-tool calls");
  });

  it("anchor renders and policy-injected nudges are not user speech", () => {
    const nudge = user("[Budget Status] plenty left. Do NOT rush");
    const nudgePart = nudge.parts[0];
    if (nudgePart?.type !== "text") throw new Error("shape");
    nudge.parts[0] = { ...nudgePart, metadata: { policyInjected: true } };

    const before = [anchorMessage("old-epoch"), user("real question"), bulk, nudge];
    const after = [anchorMessage("new-epoch"), user("real question"), nudge];
    const decoration = planDecoration(sessionId, before, after);
    if (decoration === undefined) throw new Error("expected decoration");
    expect(decoration.droppedQuotes).toEqual([]);
    // The nudge is newer than the real question, but it is not the goal.
    expect(decoration.goal).toBe("real question");
  });

  it("returns undefined when the cut reclaimed too little to pay for decoration (#727 F1)", () => {
    const keep = user("keep");
    const tiny = user("tiny dropped");
    expect(planDecoration(sessionId, [tiny, keep], [keep])).toBeUndefined();
  });

  it("the decoration never outweighs the reclaim: applied window stays smaller (#727 F1)", () => {
    const dropped = user(`constraint ${"c".repeat(900)}`);
    const goal = user(`goal ${"g".repeat(3000)}`);
    const before = [dropped, bulk, goal];
    const after = [anchorMessage("body"), goal];
    const reclaimed = contentChars(before) - contentChars(after);
    const decoration = planDecoration(sessionId, before, after);
    if (decoration === undefined) throw new Error("expected decoration");
    const base = "[Conversation Summary]\nbody";
    const grown = decorateAnchorRender(base, decoration).length - base.length;
    expect(grown).toBeLessThan(reclaimed);
  });

  it("no first-quote exemption: an over-budget newest quote is counted, not kept (#727 F2)", () => {
    const huge = user(`huge ${"h".repeat(50000)}`);
    const keep = user("keep");
    const decoration = planDecoration(sessionId, [huge, bulk, keep], [keep]);
    if (decoration === undefined) throw new Error("expected decoration");
    expect(decoration.droppedQuotes).toEqual([]);
    expect(decoration.droppedBeyondQuoteBudget).toBe(1);
    const render = decorateAnchorRender("r", decoration);
    expect(render).toContain("(1 more not quoted — quote budget)");
  });

  it("duplicate user text: the dropped twin is still quoted (multiset diff, #727 F5)", () => {
    const yesDropped = user("yes");
    const yesKept = user("yes");
    const before = [yesDropped, bulk, yesKept];
    const after = [yesKept];
    const decoration = planDecoration(sessionId, before, after);
    if (decoration === undefined) throw new Error("expected decoration");
    expect(decoration.droppedQuotes).toEqual(["yes"]);
  });

  it("rendered growth stays within the budget under heavy table + newline quotes (#727 R2)", () => {
    // The reviewer's probe C: raw-char budgeting missed "> " prefixes,
    // headers, and the (uncharged) table. This pins RENDERED cost.
    for (let index = 0; index < 40; index += 1) {
      storeToolPart("read", `/very/long/path/segment/${"p".repeat(60)}/${index}.ts`);
    }
    const newlineHeavy = user(Array.from({ length: 120 }, (_u, i) => `l${i}`).join("\n"));
    const goal = user("the goal");
    const before = [newlineHeavy, assistantText(`w ${"x".repeat(2000)}`), goal];
    const after = [anchorMessage("body"), goal];
    const reclaimed = contentChars(before) - contentChars(after);
    const decoration = planDecoration(sessionId, before, after);
    if (decoration === undefined) throw new Error("expected decoration");
    const base = "[Conversation Summary]\nbody";
    const grown = decorateAnchorRender(base, decoration).length - base.length;
    expect(grown).toBeLessThanOrEqual(decoration.budgetChars);
    expect(decoration.budgetChars * 2).toBeLessThanOrEqual(reclaimed);
  });

  it("caps the goal to an excerpt — recitation is positional, not a second copy", () => {
    const goal = user(`goal ${"g".repeat(10000)}`);
    const before = [bulk, goal];
    const after = [goal];
    const decoration = planDecoration(sessionId, before, after);
    if (decoration === undefined) throw new Error("expected decoration");
    expect(decoration.goal?.length ?? 0).toBeLessThanOrEqual(2100);
    expect(decoration.goal).toContain("(excerpt — full text is in the window)");
  });
});
