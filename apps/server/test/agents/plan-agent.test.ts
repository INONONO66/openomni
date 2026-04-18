import { describe, expect, it } from "bun:test";
import { getAgentDefinition } from "../../src/agents/registry";
import { resolveAgentName } from "../../src/router";
import type { Adapter } from "@openomni/protocol";

describe("plan agent registry", () => {
  it("getAgentDefinition returns undefined for unregistered plan agent", () => {
    const definition = getAgentDefinition("plan");
    expect(definition).toBeUndefined();
  });
});

describe("plan agent routing", () => {
  it("resolveAgentName falls back to dev when /plan prefix is used but plan agent not registered", () => {
    const message: Adapter.InboundMessage = {
      id: "msg-1",
      surfaceKey: "test:1",
      text: "/plan generate a deployment strategy",
      sender: {
        id: "user-1",
        name: "Test User",
      },
    };

    const agentName = resolveAgentName({ message });
    expect(agentName).toBe("dev");
  });

  it("resolveAgentName returns dev for non-plan messages", () => {
    const message: Adapter.InboundMessage = {
      id: "msg-2",
      surfaceKey: "test:1",
      text: "help me debug this code",
      sender: {
        id: "user-1",
        name: "Test User",
      },
    };

    const agentName = resolveAgentName({ message });
    expect(agentName).toBe("dev");
  });
});
