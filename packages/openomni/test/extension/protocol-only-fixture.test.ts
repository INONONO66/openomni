import { beforeEach, describe, expect, it } from "bun:test";
import { AgentProfile, Extension, McpConfig, Skill, Tool } from "@openomni/protocol";
import { Session, SqliteStorageAdapter, Storage } from "@openomni/session";
import { ExtensionManager } from "../../src/extension";

const agent: AgentProfile.Definition = AgentProfile.Definition.parse({
  name: "protocol-fixture-agent",
  description: "Exercises protocol-only extension authoring.",
  systemPrompt: "Use only protocol contracts when describing fixture behavior.",
  tools: ["protocol_fixture.inspect"],
  model: { provider: "fixture", id: "deterministic" },
  budget: { maxTurns: 1, maxToolCalls: 1 },
});

const tool: Tool.Spec = Tool.Spec.parse({
  name: "protocol_fixture.inspect",
  description: "Returns deterministic fixture metadata.",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string" },
    },
    required: ["subject"],
  },
  safe: true,
});

const skill: Skill.Definition = Skill.Definition.parse({
  id: "protocol-fixture-skill",
  name: "Protocol Fixture Skill",
  description: "Keeps extension fixture behavior deterministic.",
  scope: "local",
  layer: "execution",
  path: "./skills/protocol-fixture/SKILL.md",
  promptFragment: "Validate manifest contracts without runtime imports.",
  finalChecklist: ["Manifest parses through protocol schemas."],
});

const mcpServer: McpConfig.ServerConfig = McpConfig.ServerConfig.parse({
  name: "protocol-fixture-mcp",
  transport: "stdio",
  command: "protocol-fixture-mcp",
  args: ["--deterministic"],
  timeout: 1_000,
  retries: 0,
});

const manifest: Extension.Manifest = Extension.Manifest.parse({
  id: "protocol-only-fixture",
  name: "Protocol Only Fixture",
  version: "1.0.0",
  description: "A tiny extension manifest authored with protocol exports only.",
  author: "OpenOmni Test Fixture",
  contributes: {
    agents: [agent],
    tools: [tool],
    skills: [skill],
    mcpServers: [mcpServer],
  },
  compatibility: { openomni: ">=0.1.0" },
  provenance: { manifestHash: "protocol-only-fixture-1.0.0" },
});

function getManifest(): Extension.Manifest {
  return manifest;
}

const fixedDate = new Date("2026-05-04T00:00:00.000Z");
const actor = { kind: "user", id: "protocol-fixture-test" };

let sessionId: string;

beforeEach(() => {
  Storage.configure(new SqliteStorageAdapter(":memory:"));
  sessionId = Session.create({
    title: "protocol-only-fixture-test",
    model: { providerID: "test", modelID: "test" },
  }).id;
});

describe("protocol-only extension fixture", () => {
  it("builds a protocol manifest accepted by ExtensionManager lifecycle", async () => {
    const manifest = getManifest();
    const parsed = Extension.Manifest.parse(manifest);

    expect(parsed.contributes?.agents).toHaveLength(1);
    expect(parsed.contributes?.tools).toHaveLength(1);
    expect(parsed.contributes?.skills).toHaveLength(1);
    expect(parsed.contributes?.mcpServers).toHaveLength(1);

    const validation = await ExtensionManager.validate(parsed, operationOptions());
    expect(validation.success).toBe(true);

    const proposed = await ExtensionManager.requestInstall(parsed, {
      ...operationOptions(),
      reason: "protocol-only fixture contract",
    });
    expect(proposed).toMatchObject({ id: parsed.id, version: parsed.version, state: "proposed" });
    expect(proposed.manifest?.contributes).toEqual({
      agents: 1,
      tools: 1,
      skills: 1,
      mcpServers: 1,
      middlewares: 0,
      surfaces: 0,
    });

    await ExtensionManager.approve(parsed.id, operationOptions());
    await ExtensionManager.install(parsed.id, operationOptions());
    const enabled = await ExtensionManager.enable(parsed.id, operationOptions());

    expect(enabled).toMatchObject({ id: parsed.id, version: parsed.version, state: "enabled" });
  });
});

function operationOptions() {
  return {
    actor,
    audit: { sessionId },
    now: () => fixedDate,
  };
}
