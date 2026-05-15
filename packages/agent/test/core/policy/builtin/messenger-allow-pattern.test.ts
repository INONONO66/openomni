import { describe, expect, it } from "bun:test";
import { createMessengerAllowPatternPolicy } from "../../../../src/core/policy/builtin/messenger-allow-pattern";
import type { PolicyContext } from "../../../../src/core/policy";
import type { Messenger } from "@openomni/protocol";
import { firstReason } from "../../../helpers/policy-decision";

function baseCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    timing: "invoke.prepare",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function envelope(from: string, to: string): Messenger.MessageEnvelope {
  return {
    id: "env-1",
    traceId: "trace-1",
    correlationId: null,
    sessionId: "session-1",
    runId: "run-1",
    fromAgentId: from,
    toAgentId: to,
    sentAt: new Date().toISOString(),
    schemaRef: "test",
    payload: {},
    persistencePolicy: "both",
  };
}

describe("createMessengerAllowPatternPolicy", () => {
  it("continue — no envelope (no fromAgentId/toAgentId)", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [{ from: "a", to: "b" }],
    });
    const verdict = await mw.fn(baseCtx());

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("default_allow");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  it("continue — no allowPatterns configured (default allow)", async () => {
    const mw = createMessengerAllowPatternPolicy({});
    const verdict = await mw.fn(baseCtx({ envelope: envelope("agent-a", "agent-b") }));

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("no_allow_patterns_configured");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  it("continue — empty allowPatterns array (default allow)", async () => {
    const mw = createMessengerAllowPatternPolicy({ allowPatterns: [] });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("agent-a", "agent-b") }));

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("no_allow_patterns_configured");
  });

  it("continue — exact pattern match allows", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("agent-a", "agent-b") }));

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("allow_pattern_matched");
  });

  it("abort — no pattern matches denies", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("agent-x", "agent-y") }));

    expect(verdict.verdict).toBe("deny");
    expect(firstReason(verdict)).toContain("authorization denied");
    expect(firstReason(verdict)).toContain("agent-x");
    expect(firstReason(verdict)).toContain("agent-y");
  });

  it("continue — wildcard from allows any sender", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [{ from: "*", to: "agent-b" }],
    });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("any-sender", "agent-b") }));

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("allow_pattern_matched");
  });

  it("continue — wildcard to allows any receiver", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [{ from: "agent-a", to: "*" }],
    });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("agent-a", "any-receiver") }));

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("allow_pattern_matched");
  });

  it("continue — double wildcard allows everything", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [{ from: "*", to: "*" }],
    });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("x", "y") }));

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("allow_pattern_matched");
  });

  it("abort — partial match (from matches, to does not) denies", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("agent-a", "agent-c") }));

    expect(verdict.verdict).toBe("deny");
    expect(firstReason(verdict)).toContain("authorization denied");
  });

  it("continue — multiple patterns, second matches", async () => {
    const mw = createMessengerAllowPatternPolicy({
      allowPatterns: [
        { from: "agent-x", to: "agent-y" },
        { from: "agent-a", to: "agent-b" },
      ],
    });
    const verdict = await mw.fn(baseCtx({ envelope: envelope("agent-a", "agent-b") }));

    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("allow_pattern_matched");
  });

  it("has name builtin:messenger-allow-pattern", () => {
    const mw = createMessengerAllowPatternPolicy({});
    expect(mw.name).toBe("builtin:messenger-allow-pattern");
  });

  it("has timing invoke.prepare", () => {
    const mw = createMessengerAllowPatternPolicy({});
    expect(mw.timing).toBe("invoke.prepare");
  });

  it("has priority 0", () => {
    const mw = createMessengerAllowPatternPolicy({});
    expect(mw.priority).toBe(0);
  });

  it("has failPolicy fail-closed", () => {
    const mw = createMessengerAllowPatternPolicy({});
    expect(mw.failPolicy).toBe("fail-closed");
  });
});
