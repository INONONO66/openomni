import { describe, it, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { AgentDiscovery } from "../../src/agent/discovery/discovery";
import { parseFrontmatter } from "../../src/agent/discovery/frontmatter";
import { BuiltinAgentRegistry } from "../../src/agent/registry/registry";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures/agents");

beforeEach(() => {
  BuiltinAgentRegistry.clear();
});

describe("parseFrontmatter", () => {
  it("extracts YAML data and markdown body", () => {
    const content = `---
name: "test"
description: "desc"
---

# Body content`;

    const { data, body } = parseFrontmatter(content);
    expect(data.name).toBe("test");
    expect(data.description).toBe("desc");
    expect(body).toBe("# Body content");
  });

  it("throws when frontmatter opening delimiter is missing", () => {
    expect(() => parseFrontmatter("no frontmatter")).toThrow(
      "Missing frontmatter: file must start with ---",
    );
  });

  it("throws when frontmatter closing delimiter is missing", () => {
    expect(() => parseFrontmatter("---\nname: test\n")).toThrow(
      "Missing frontmatter: no closing --- found",
    );
  });

  it("parses nested objects", () => {
    const content = `---
permissions:
  read: true
  write: false
---`;

    const { data } = parseFrontmatter(content);
    expect(data.permissions).toEqual({ read: true, write: false });
  });

  it("parses inline arrays", () => {
    const content = `---
tools: [read, grep, glob]
---`;

    const { data } = parseFrontmatter(content);
    expect(data.tools).toEqual(["read", "grep", "glob"]);
  });

  it("parses block arrays", () => {
    const content = `---
tools:
  - read
  - grep
  - glob
---`;

    const { data } = parseFrontmatter(content);
    expect(data.tools).toEqual(["read", "grep", "glob"]);
  });

  it("parses quoted strings", () => {
    const content = `---
name: "my-agent"
description: 'single quoted'
---`;

    const { data } = parseFrontmatter(content);
    expect(data.name).toBe("my-agent");
    expect(data.description).toBe("single quoted");
  });

  it("parses numbers", () => {
    const content = `---
maxTurns: 25
---`;

    const { data } = parseFrontmatter(content);
    expect(data.maxTurns).toBe(25);
  });
});

describe("AgentDiscovery.load", () => {
  it("loads valid worker agent from .md file", () => {
    const results = AgentDiscovery.load(FIXTURES_DIR);
    const worker = results.find((r) => r.agent?.name === "code-analyzer");

    expect(worker).toBeDefined();
    expect(worker!.success).toBe(true);
    expect(worker!.agent!.name).toBe("code-analyzer");
    expect(worker!.agent!.tools).toEqual(["read", "grep", "glob"]);
    expect(worker!.agent!.permissions.read).toBe(true);
    expect(worker!.agent!.permissions.write).toBe(false);
    expect(worker!.agent!.maxTurns).toBe(15);
  });

  it("loads valid supervisor agent from .md file", () => {
    const results = AgentDiscovery.load(FIXTURES_DIR);
    const supervisor = results.find(
      (r) => r.agent?.name === "conversation-supervisor",
    );

    expect(supervisor).toBeDefined();
    expect(supervisor!.success).toBe(true);
    expect(supervisor!.agent!.name).toBe("conversation-supervisor");
    expect(supervisor!.agent!.permissions.lsp).toBe(true);
    expect(supervisor!.agent!.maxTurns).toBe(50);
  });

  it("appends markdown body to systemPrompt", () => {
    const results = AgentDiscovery.load(FIXTURES_DIR);
    const worker = results.find((r) => r.agent?.name === "code-analyzer");

    expect(worker!.agent!.systemPrompt).toContain(
      "You are a code analysis agent.",
    );
    expect(worker!.agent!.systemPrompt).toContain("Extended Instructions");
    expect(worker!.agent!.systemPrompt).toContain("anti-patterns");
  });

  it("rejects invalid frontmatter with Zod validation failure", () => {
    const results = AgentDiscovery.load(FIXTURES_DIR);
    const invalid = results.find((r) => r.file.includes("invalid.md"));

    expect(invalid).toBeDefined();
    expect(invalid!.success).toBe(false);
    expect(invalid!.error).toBeDefined();
  });

  it("registers loaded agents in BuiltinAgentRegistry", () => {
    AgentDiscovery.load(FIXTURES_DIR);

    expect(BuiltinAgentRegistry.has("code-analyzer")).toBe(true);
    expect(BuiltinAgentRegistry.has("conversation-supervisor")).toBe(true);
  });

  it("returns empty array for non-existent directory", () => {
    const results = AgentDiscovery.load("/non/existent/path");
    expect(results).toEqual([]);
  });

  it("throws in strict mode for non-existent directory", () => {
    expect(() =>
      AgentDiscovery.load("/non/existent/path", { strict: true }),
    ).toThrow("Agent discovery directory does not exist");
  });
});

describe("AgentDiscovery override protection", () => {
  it("rejects when agent name conflicts and no override flag", () => {
    BuiltinAgentRegistry.define({
      name: "code-analyzer",
      description: "existing agent",
      systemPrompt: "existing",
      tools: ["read"],
      permissions: {
        read: true,
        write: false,
        bash: false,
        lsp: false,
        grep: false,
        glob: false,
      },
    });

    const results = AgentDiscovery.load(FIXTURES_DIR);
    const worker = results.find((r) => r.file.includes("valid-worker.md"));

    expect(worker!.success).toBe(false);
    expect(worker!.error).toContain("already exists");
    expect(worker!.error).toContain("allowOverride is not set");
  });

  it("allows override when allowOverride flag is set", () => {
    BuiltinAgentRegistry.define({
      name: "code-analyzer",
      description: "existing agent",
      systemPrompt: "existing",
      tools: ["read"],
      permissions: {
        read: true,
        write: false,
        bash: false,
        lsp: false,
        grep: false,
        glob: false,
      },
    });

    const results = AgentDiscovery.load(FIXTURES_DIR, {
      allowOverride: true,
    });
    const worker = results.find((r) => r.file.includes("valid-worker.md"));

    expect(worker!.success).toBe(true);
    expect(worker!.agent!.description).toBe(
      "Analyzes codebases for patterns and issues",
    );

    const registered = BuiltinAgentRegistry.get("code-analyzer");
    expect(registered!.description).toBe(
      "Analyzes codebases for patterns and issues",
    );
  });

  it("throws in strict mode when agent name conflicts without override", () => {
    BuiltinAgentRegistry.define({
      name: "code-analyzer",
      description: "existing",
      systemPrompt: "existing",
      tools: [],
      permissions: {
        read: false,
        write: false,
        bash: false,
        lsp: false,
        grep: false,
        glob: false,
      },
    });

    expect(() =>
      AgentDiscovery.loadFile(join(FIXTURES_DIR, "valid-worker.md"), {
        strict: true,
      }),
    ).toThrow("already exists");
  });
});

describe("AgentDiscovery.loadFile", () => {
  it("loads a single agent file", () => {
    const result = AgentDiscovery.loadFile(
      join(FIXTURES_DIR, "valid-worker.md"),
    );

    expect(result.success).toBe(true);
    expect(result.agent!.name).toBe("code-analyzer");
  });

  it("returns failure for invalid file", () => {
    const result = AgentDiscovery.loadFile(join(FIXTURES_DIR, "invalid.md"));

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
