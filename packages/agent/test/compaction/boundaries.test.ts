import { describe, expect, it } from "bun:test";
import { planAnchoredCut } from "../../src/compaction/candidate";
import { createCompactionPlan, restoreCompactionProjection } from "../../src/compaction/durable";
import { CompactionSession } from "../../src/compaction/speculate";
import { textMessage } from "../helpers/messages";

function history() {
  return [
    textMessage("assistant", "evidence ".repeat(100), "session", "first"),
    textMessage("user", "tail", "session", "last"),
  ];
}

describe("compaction boundary integrity", () => {
  it("rejects empty or entirely retained histories", () => {
    const prior = history();
    expect(() => createCompactionPlan([], prior, 10)).toThrow();
    expect(() => createCompactionPlan(prior, prior, 10)).toThrow();
  });

  it("rejects changed revert evidence", () => {
    const prior = history();
    const plan = createCompactionPlan(prior, prior.slice(1), 10);
    const changed = {
      ...plan.record,
      revert: { ...plan.record.revert, removedEntries: [] },
    };
    expect(() => restoreCompactionProjection(plan.projection, changed)).toThrow();
    expect(restoreCompactionProjection(plan.projection, plan.record)).toEqual(prior);
  });

  it("fingerprints reasoning and step boundaries rather than just visible text", () => {
    const messages = history();
    const first = messages[0];
    if (first === undefined) throw new Error("missing fixture");
    const before = planAnchoredCut(messages, 1)?.prefixFingerprint;
    first.parts.push({
      id: "reasoning",
      messageID: first.info.id,
      sessionID: first.info.sessionID,
      type: "reasoning",
      text: "reason",
      signature: "signature",
      time: { start: 1 },
    });
    const reasoned = planAnchoredCut(messages, 1)?.prefixFingerprint;
    expect(reasoned).not.toBe(before);
    first.parts.push({
      id: "step",
      messageID: first.info.id,
      sessionID: first.info.sessionID,
      type: "step-start",
    });
    const started = planAnchoredCut(messages, 1)?.prefixFingerprint;
    expect(started).not.toBe(reasoned);
    first.parts.push({
      id: "finish",
      messageID: first.info.id,
      sessionID: first.info.sessionID,
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(planAnchoredCut(messages, 1)?.prefixFingerprint).not.toBe(started);
  });

  it("consumes candidates and disables further speculative work", async () => {
    let calls = 0;
    const session = new CompactionSession({
      protectRecentMessages: 1,
      summarize: async (messages) => {
        calls += 1;
        return messages.map((message) => message.info.id).join(",");
      },
    });
    session.prepare(history(), 70, 60, 1000);
    expect(session.inFlight()).toBe(true);
    await session.settled();
    expect(session.candidate()?.anchorBody).toBe("first");
    expect(session.inFlight()).toBe(false);
    session.consume();
    expect(session.candidate()).toBeUndefined();
    session.disable();
    session.prepare(history(), 70, 60, 1000);
    await session.settled();
    expect(calls).toBe(1);
  });
});
