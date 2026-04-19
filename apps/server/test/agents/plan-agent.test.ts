import { describe, expect, it } from "bun:test";
import { getAgentDefinition } from "../../src/agents/registry";
import { resolveAgentName } from "../../src/router";
import type { Adapter } from "@openomni/protocol";

describe("plan agent registry", () => {
  it("getAgentDefinition returns definition for registered plan agent", () => {
    const definition = getAgentDefinition("plan");
    expect(definition).toBeDefined();
    expect(definition?.name).toBe("plan");
  });
});

describe("plan agent routing", () => {
  it("resolveAgentName returns plan for /plan slash command", () => {
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
    expect(agentName).toBe("plan");
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
