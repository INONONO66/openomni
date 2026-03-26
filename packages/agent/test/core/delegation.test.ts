import { describe, expect, it } from "bun:test";
import { checkDelegation } from "../../src/core/delegation";
import type { DelegationContext } from "../../src/core/delegation";

const makeContext = (overrides: Partial<DelegationContext> = {}): DelegationContext => ({
  depth: 0,
  maxDepth: 3,
  visitedAgents: new Set(),
  parentAbort: new AbortController().signal,
  budgetPolicy: "inherit",
  ...overrides,
});

describe("checkDelegation", () => {
  it("allows delegation when depth is below max and agent not visited", () => {
    const ctx = makeContext({ depth: 0, maxDepth: 3 });
    expect(checkDelegation("agent-a", ctx)).toBe("allow");
  });

  it("detects circular delegation when agent already visited", () => {
    const ctx = makeContext({ visitedAgents: new Set(["agent-a", "agent-b"]) });
    expect(checkDelegation("agent-a", ctx)).toBe("circular_detected");
  });

  it("allows new agent not in visited set", () => {
    const ctx = makeContext({ visitedAgents: new Set(["agent-a", "agent-b"]) });
    expect(checkDelegation("agent-c", ctx)).toBe("allow");
  });

  it("returns depth_exceeded when depth equals maxDepth", () => {
    const ctx = makeContext({ depth: 3, maxDepth: 3 });
    expect(checkDelegation("agent-x", ctx)).toBe("depth_exceeded");
  });

  it("returns depth_exceeded when depth exceeds maxDepth", () => {
    const ctx = makeContext({ depth: 5, maxDepth: 3 });
    expect(checkDelegation("agent-x", ctx)).toBe("depth_exceeded");
  });

  it("allows when depth is one below maxDepth", () => {
    const ctx = makeContext({ depth: 2, maxDepth: 3 });
    expect(checkDelegation("agent-x", ctx)).toBe("allow");
  });

  it("circular detection takes priority over depth check", () => {
    const ctx = makeContext({
      depth: 5,
      maxDepth: 3,
      visitedAgents: new Set(["agent-a"]),
    });
    expect(checkDelegation("agent-a", ctx)).toBe("circular_detected");
  });
});
