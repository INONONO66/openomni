import { describe, it, expect } from "bun:test";
import { resolveAgentName } from "../src/router";
import type { Adapter } from "@openomni/protocol";

function makeMessage(text: string, surfaceKey = "discord:guild1:general"): Adapter.InboundMessage {
  return {
    id: crypto.randomUUID(),
    surfaceKey,
    text,
    sender: { id: "user1", name: "TestUser" },
  };
}

describe("resolveAgentName", () => {
  it("returns default agent for plain messages", () => {
    const name = resolveAgentName({ message: makeMessage("hello") });
    expect(name).toBe("dev");
  });

  it("routes /dev slash command to dev agent", () => {
    const name = resolveAgentName({
      message: makeMessage("/dev implement feature X"),
    });
    expect(name).toBe("dev");
  });

  it("falls back to default for unknown slash command", () => {
    const name = resolveAgentName({
      message: makeMessage("/unknown do something"),
    });
    expect(name).toBe("dev");
  });

  it("routes by channel name in surfaceKey", () => {
    const name = resolveAgentName({
      message: makeMessage("help me", "discord:guild1:dev"),
    });
    expect(name).toBe("dev");
  });

  it("routes by 'development' channel trigger", () => {
    const name = resolveAgentName({
      message: makeMessage("help", "slack:workspace:development"),
    });
    expect(name).toBe("dev");
  });

  it("channel matching is case-insensitive", () => {
    const name = resolveAgentName({
      message: makeMessage("hi", "discord:guild1:DEV"),
    });
    expect(name).toBe("dev");
  });

  it("uses custom default agent when provided", () => {
    const name = resolveAgentName({
      message: makeMessage("hello"),
      defaultAgent: "ops",
    });
    expect(name).toBe("ops");
  });

  it("slash command takes priority over channel match", () => {
    const name = resolveAgentName({
      message: makeMessage("/dev fix bug", "discord:guild1:random"),
    });
    expect(name).toBe("dev");
  });

  it("text starting with / but no valid command falls through", () => {
    const name = resolveAgentName({
      message: makeMessage("/ no command here"),
    });
    // "/" followed by space — parseSlashCommand returns null (empty command)
    expect(name).toBe("dev");
  });

  it("routes /dev slash command with leading whitespace", () => {
    const name = resolveAgentName({
      message: makeMessage("  /dev implement feature X"),
      defaultAgent: "plan",
    });
    expect(name).toBe("dev");
  });

  it("handles multiple leading spaces before slash command", () => {
    const name = resolveAgentName({
      message: makeMessage("    /dev fix bug"),
      defaultAgent: "plan",
    });
    expect(name).toBe("dev");
  });
});
