import { beforeAll, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/ledger";
import { createRecallTool } from "./recall.js";

/**
 * L1 (#711): an elided output must be recoverable byte-exact from the
 * session store, without re-running the tool. Compaction rewrites only the
 * in-run history (`run.replace_messages`); the store keeps the part as
 * recorded at completion — recall reads that record by callID.
 */

// Deliberately byte-sensitive: multibyte, control chars, marker-lookalike.
const ORIGINAL_OUTPUT = `line1\n한글과 emoji 🧭\n\ttabbed\n${"x".repeat(400)}\n[output elided by compaction: 1 chars; recall: decoy]`;

let sessionId: string;
const CALL_ID = "call-recall-test-1";

function assistantMessage(id: string, session: string): Message.Info {
  return {
    id,
    sessionID: session,
    role: "assistant",
    time: { created: 1 },
    parentID: "",
    modelID: "m",
    providerID: "p",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function toolPart(id: string, messageID: string, session: string, callID: string): Message.Part {
  return {
    id,
    sessionID: session,
    messageID,
    type: "tool",
    callID,
    tool: "read",
    state: {
      status: "completed",
      input: {},
      output: ORIGINAL_OUTPUT,
      title: "read",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

beforeAll(() => {
  Storage.initialize({ dbPath: ":memory:" });
  const session = Session.create({
    traceId: "recall-test-trace",
    title: "recall test",
    model: { providerID: "p", modelID: "m" },
  });
  sessionId = session.id;

  const message = assistantMessage("recall-msg-1", sessionId);
  Session.addMessage(sessionId, message);
  Session.addPart(message.id, toolPart("recall-part-1", message.id, sessionId, CALL_ID));

  // A running (non-terminal) sibling: recall must refuse it, not return junk.
  const pending = assistantMessage("recall-msg-2", sessionId);
  Session.addMessage(sessionId, pending);
  Session.addPart(pending.id, {
    id: "recall-part-2",
    sessionID: sessionId,
    messageID: pending.id,
    type: "tool",
    callID: "call-still-running",
    tool: "read",
    state: { status: "running", input: {}, time: { start: 1 } },
  });
});

describe("recall.output", () => {
  it("returns the recorded original byte-exact by callID", async () => {
    const tool = createRecallTool();
    const result = await tool.execute({
      id: "c1",
      tool: "recall.output",
      input: { callId: CALL_ID, sessionId },
    });

    expect(result.isError ?? false).toBe(false);
    expect(result.output).toBe(ORIGINAL_OUTPUT);
  });

  it("refuses an unknown callId with a loud error result", async () => {
    const tool = createRecallTool();
    const result = await tool.execute({
      id: "c2",
      tool: "recall.output",
      input: { callId: "call-does-not-exist", sessionId },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("no tool call call-does-not-exist");
  });

  it("refuses a non-completed tool call instead of fabricating output", async () => {
    const tool = createRecallTool();
    const result = await tool.execute({
      id: "c3",
      tool: "recall.output",
      input: { callId: "call-still-running", sessionId },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status "running"');
  });

  it("refuses to run without an executor-injected sessionId", async () => {
    const tool = createRecallTool();
    const result = await tool.execute({
      id: "c4",
      tool: "recall.output",
      input: { callId: CALL_ID },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("session-bound executor runtime");
  });

  it("cannot reach another session's outputs", async () => {
    const other = Session.create({
      traceId: "recall-test-trace-2",
      title: "other session",
      model: { providerID: "p", modelID: "m" },
    });
    const tool = createRecallTool();
    const result = await tool.execute({
      id: "c5",
      tool: "recall.output",
      input: { callId: CALL_ID, sessionId: other.id },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain(`no tool call ${CALL_ID}`);
  });

  it("refuses a duplicated callId instead of guessing between calls", async () => {
    // Providers mint per-turn ids (call_0, call_1) that can repeat across
    // turns — returning the oldest match would be byte-exact and wrong
    // (PR #719 review M3).
    const dup = "call_0";
    const m1 = assistantMessage("recall-dup-1", sessionId);
    Session.addMessage(sessionId, m1);
    Session.addPart(m1.id, toolPart("recall-dup-part-1", m1.id, sessionId, dup));
    const m2 = assistantMessage("recall-dup-2", sessionId);
    Session.addMessage(sessionId, m2);
    Session.addPart(m2.id, toolPart("recall-dup-part-2", m2.id, sessionId, dup));

    const tool = createRecallTool();
    const result = await tool.execute({
      id: "c6",
      tool: "recall.output",
      input: { callId: dup, sessionId },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("ambiguous callId call_0: 2 recorded tool calls");
  });

  it("declares session scoping to the executor via implicit inputs", () => {
    const tool = createRecallTool();
    expect(tool.implicitInputs).toEqual({ sessionId: "sessionId" });
    expect(tool.riskTier).toBe(0);
  });
});
