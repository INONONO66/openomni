import { describe, expect, it } from "bun:test";
import type { Extension } from "@openomni/protocol";
import { RuntimeBinding } from "../../src/extension";

describe("RuntimeBinding", () => {
  it("registers contributed components deterministically and disables them in reverse order", async () => {
    const calls: string[] = [];
    const binding = new RuntimeBinding({
      agents: {
        define: (definition, context) =>
          record(calls, `agent.register:${definition.name}:${context.extensionId}`),
        remove: (name, _definition, context) =>
          record(calls, `agent.remove:${name}:${context.version}`),
      },
      tools: {
        register: (spec, context) =>
          record(calls, `tool.register:${spec.name}:${context.extensionId}`),
        unregister: (name, _spec, context) =>
          record(calls, `tool.unregister:${name}:${context.version}`),
      },
      skills: {
        register: (definition, context) =>
          record(calls, `skill.register:${definition.id}:${context.extensionId}`),
        unregister: (id, _definition, context) =>
          record(calls, `skill.unregister:${id}:${context.version}`),
      },
      mcpServers: {
        addServer: (config, context) =>
          record(calls, `mcp.add:${config.name}:${context.extensionId}`),
        removeServer: (name, _config, context) =>
          record(calls, `mcp.remove:${name}:${context.version}`),
      },
      surfaces: {
        register: (surface, context) =>
          record(calls, `surface.register:${surface.surfaceId}:${context.extensionId}`),
        unregister: (surfaceId, _surface, context) =>
          record(calls, `surface.unregister:${surfaceId}:${context.version}`),
      },
      middlewares: {
        register: (definition, context) =>
          record(calls, `middleware.register:${definition.name}:${context.extensionId}`),
        unregister: (name, _definition, context) =>
          record(calls, `middleware.unregister:${name}:${context.version}`),
      },
    });

    await binding.enable({ id: "ext", version: "1.0.0", contributes: contributions() });
    await binding.disable({ id: "ext", version: "1.0.0" });

    expect(calls).toEqual([
      "agent.register:writer:ext",
      "tool.register:writer.publish:ext",
      "skill.register:publish-skill:ext",
      "mcp.add:content-db:ext",
      "surface.register:discord:ext",
      "middleware.register:content-guard:ext",
      "middleware.unregister:content-guard:1.0.0",
      "surface.unregister:discord:1.0.0",
      "mcp.remove:content-db:1.0.0",
      "skill.unregister:publish-skill:1.0.0",
      "tool.unregister:writer.publish:1.0.0",
      "agent.remove:writer:1.0.0",
    ]);
  });

  it("rolls back already registered components when a later target fails", async () => {
    const calls: string[] = [];
    const binding = new RuntimeBinding({
      agents: {
        define: (definition) => record(calls, `agent.register:${definition.name}`),
        remove: (name) => record(calls, `agent.remove:${name}`),
      },
      tools: {
        register: (spec) => record(calls, `tool.register:${spec.name}`),
        unregister: (name) => record(calls, `tool.unregister:${name}`),
      },
      skills: {
        register: (definition) => record(calls, `skill.register:${definition.id}`),
        unregister: (id) => record(calls, `skill.unregister:${id}`),
      },
      mcpServers: {
        addServer: (config) => {
          calls.push(`mcp.add:${config.name}`);
          throw new Error("mcp unavailable");
        },
        removeServer: (name) => record(calls, `mcp.remove:${name}`),
      },
      surfaces: {
        register: (surface) => record(calls, `surface.register:${surface.surfaceId}`),
        unregister: (surfaceId) => record(calls, `surface.unregister:${surfaceId}`),
      },
      middlewares: {
        register: (definition) => record(calls, `middleware.register:${definition.name}`),
        unregister: (name) => record(calls, `middleware.unregister:${name}`),
      },
    });

    await expectRejectsWithMessage(
      binding.enable({ id: "ext", version: "1.0.0", contributes: contributions() }),
      "mcp unavailable",
    );

    expect(calls).toEqual([
      "agent.register:writer",
      "tool.register:writer.publish",
      "skill.register:publish-skill",
      "mcp.add:content-db",
      "skill.unregister:publish-skill",
      "tool.unregister:writer.publish",
      "agent.remove:writer",
    ]);
  });

  it("fails before side effects when a contributed kind has no target", async () => {
    const calls: string[] = [];
    const binding = new RuntimeBinding({
      tools: {
        register: (spec) => record(calls, `tool.register:${spec.name}`),
        unregister: (name) => record(calls, `tool.unregister:${name}`),
      },
    });

    await expectRejectsWithMessage(
      binding.enable({ id: "ext", version: "1.0.0", contributes: contributions() }),
      "agents",
    );
    expect(calls).toEqual([]);
  });
});

function record(calls: string[], value: string): void {
  calls.push(value);
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
  let caughtError: unknown;
  try {
    await promise;
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(Error);
  expect(caughtError instanceof Error ? caughtError.message : "").toContain(message);
}

function contributions(): Extension.Contributes {
  return {
    agents: [
      {
        name: "writer",
        description: "Writes campaign copy",
        tools: ["writer.publish"],
      },
    ],
    tools: [
      {
        name: "writer.publish",
        description: "Publishes draft content",
        inputSchema: {},
      },
    ],
    skills: [
      {
        id: "publish-skill",
        name: "Publish Skill",
        description: "Publishing workflow",
        scope: "local",
        layer: "execution",
        path: ".openomni/skills/publish-skill/SKILL.md",
        promptFragment: "Publish carefully.",
      },
    ],
    mcpServers: [
      {
        name: "content-db",
        transport: "stdio",
        command: "content-db",
      },
    ],
    surfaces: [{ surfaceId: "discord", adapterType: "discord" }],
    middlewares: [{ name: "content-guard", timing: "pre_tool_use", priority: 10 }],
  };
}
