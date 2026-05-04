import { describe, expect, test } from "bun:test";
import { Extension } from "../src/index.js";

const it = test;

const BASE_EVENT = {
  extensionId: "ext-test",
  version: "1.0.0",
  actor: "user:admin",
  time: 1714809600000,
};

describe("Extension protocol domain", () => {
  describe("Extension.LifecycleState", () => {
    it("accepts all nine state values", () => {
      const states = [
        "proposed",
        "approved",
        "staged",
        "installed",
        "enabled",
        "disabled",
        "rolled_back",
        "uninstalled",
        "failed",
      ] as const;

      for (const state of states) {
        expect(Extension.LifecycleState.safeParse(state).success).toBe(true);
      }
    });

    it("rejects invalid state values", () => {
      expect(Extension.LifecycleState.safeParse("active").success).toBe(false);
      expect(Extension.LifecycleState.safeParse("").success).toBe(false);
      expect(Extension.LifecycleState.safeParse(null).success).toBe(false);
    });
  });

  describe("Extension.Manifest", () => {
    it("parses a minimal manifest", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-minimal",
        name: "Minimal Extension",
        version: "1.0.0",
        description: "A minimal extension with no components",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("ext-minimal");
        expect(result.data.version).toBe("1.0.0");
        expect(result.data.contributes).toBeUndefined();
        expect(result.data.permissions).toBeUndefined();
        expect(result.data.provenance).toBeUndefined();
        expect(result.data.compatibility).toBeUndefined();
      }
    });

    it("parses a manifest with contributes.agents", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-agents",
        name: "Agent Extension",
        version: "1.0.0",
        description: "Contributes agents",
        contributes: {
          agents: [
            {
              name: "Research Agent",
              description: "Performs research",
              tools: ["web_search"],
            },
          ],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const agents = result.data.contributes?.agents;
        expect(agents).toHaveLength(1);
        expect(agents?.[0]?.name).toBe("Research Agent");
      }
    });

    it("parses a manifest with contributes.tools", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-tools",
        name: "Tool Extension",
        version: "1.0.0",
        description: "Contributes tools",
        contributes: {
          tools: [
            {
              name: "custom_search",
              description: "Custom search",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contributes?.tools?.[0]?.name).toBe("custom_search");
      }
    });

    it("parses a manifest with contributes.skills", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-skills",
        name: "Skill Extension",
        version: "1.0.0",
        description: "Contributes skills",
        contributes: {
          skills: [
            {
              id: "skill-review",
              name: "Code Review",
              description: "Reviews code",
              scope: "local" as const,
              layer: "guarantee" as const,
              path: ".openomni/skills/code-review/SKILL.md",
            },
          ],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contributes?.skills?.[0]?.layer).toBe("guarantee");
      }
    });

    it("parses a manifest with contributes.mcpServers", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-mcp",
        name: "MCP Extension",
        version: "1.0.0",
        description: "Contributes MCP servers",
        contributes: {
          mcpServers: [
            {
              name: "filesystem",
              transport: "stdio" as const,
              command: "mcp-server-filesystem",
              args: ["/tmp"],
            },
          ],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contributes?.mcpServers?.[0]?.transport).toBe("stdio");
      }
    });

    it("parses a manifest with contributes.middlewares", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-middleware",
        name: "Middleware Extension",
        version: "1.0.0",
        description: "Contributes middlewares",
        contributes: {
          middlewares: [
            {
              name: "rate-limiter",
              timing: "pre_tool_use",
              priority: 10,
            },
          ],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contributes?.middlewares?.[0]?.name).toBe("rate-limiter");
      }
    });

    it("parses a manifest with contributes.surfaces", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-surfaces",
        name: "Surface Extension",
        version: "1.0.0",
        description: "Contributes surface bindings",
        contributes: {
          surfaces: [{ surfaceId: "discord" }, { surfaceId: "telegram", adapterType: "bot" }],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const surfaces = result.data.contributes?.surfaces;
        expect(surfaces).toHaveLength(2);
        expect(surfaces?.[0]?.surfaceId).toBe("discord");
        expect(surfaces?.[1]?.adapterType).toBe("bot");
      }
    });

    it("parses a manifest with permissions", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-perms",
        name: "Permissioned Extension",
        version: "1.0.0",
        description: "Requests permissions",
        permissions: [
          {
            action: "tool.call",
            allowlist: ["web_search", "summarize"],
          },
        ],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const perms = result.data.permissions;
        expect(perms).toHaveLength(1);
        expect(perms?.[0]?.action).toBe("tool.call");
        expect(perms?.[0]?.allowlist).toEqual(["web_search", "summarize"]);
      }
    });

    it("parses a manifest with provenance", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-provenance",
        name: "Provenance Extension",
        version: "1.0.0",
        description: "Has provenance metadata",
        provenance: {
          manifestHash: "sha256:abc123def456",
          packageHash: "sha256:fedcba654321",
          signedBy: "persona:main",
          createdByRunId: "run-abc123",
          sourceSessionId: "ses-xyz789",
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.provenance?.manifestHash).toBe("sha256:abc123def456");
        expect(result.data.provenance?.packageHash).toBe("sha256:fedcba654321");
        expect(result.data.provenance?.signedBy).toBe("persona:main");
        expect(result.data.provenance?.createdByRunId).toBe("run-abc123");
        expect(result.data.provenance?.sourceSessionId).toBe("ses-xyz789");
      }
    });

    it("parses a manifest with provenance using only manifestHash", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-provenance-minimal",
        name: "Minimal Provenance",
        version: "1.0.0",
        description: "Only manifestHash required",
        provenance: { manifestHash: "sha256:minimalonly" },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.provenance?.manifestHash).toBe("sha256:minimalonly");
        expect(result.data.provenance?.packageHash).toBeUndefined();
        expect(result.data.provenance?.signedBy).toBeUndefined();
      }
    });

    it("rejects provenance missing required manifestHash", () => {
      expect(
        Extension.Manifest.safeParse({
          id: "ext-bad-provenance",
          name: "Bad Provenance",
          version: "1.0.0",
          description: "Missing manifestHash",
          provenance: { signedBy: "persona:main" },
        }).success,
      ).toBe(false);
    });

    it("parses a manifest contributing agents, tools, skills, and MCP servers together", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-full-contributes",
        name: "Full Contributes Extension",
        version: "1.0.0",
        description: "Contributes all four component types",
        contributes: {
          agents: [
            {
              name: "Research Agent",
              description: "Performs research tasks",
              tools: ["web_search", "summarize"],
            },
          ],
          tools: [
            {
              name: "custom_search",
              description: "Custom search tool",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
          skills: [
            {
              id: "skill-review",
              name: "Code Review",
              description: "Reviews code for quality",
              scope: "local" as const,
              layer: "guarantee" as const,
              path: ".openomni/skills/code-review/SKILL.md",
            },
          ],
          mcpServers: [
            {
              name: "filesystem",
              transport: "stdio" as const,
              command: "mcp-server-filesystem",
              args: ["/tmp"],
            },
          ],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const c = result.data.contributes;
        expect(c?.agents).toHaveLength(1);
        expect(c?.agents?.[0]?.name).toBe("Research Agent");
        expect(c?.tools).toHaveLength(1);
        expect(c?.tools?.[0]?.name).toBe("custom_search");
        expect(c?.skills).toHaveLength(1);
        expect(c?.skills?.[0]?.layer).toBe("guarantee");
        expect(c?.mcpServers).toHaveLength(1);
        expect(c?.mcpServers?.[0]?.transport).toBe("stdio");
      }
    });

    it("parses a manifest with compatibility.openomni", () => {
      const result = Extension.Manifest.safeParse({
        id: "ext-compat",
        name: "Compatible Extension",
        version: "1.0.0",
        description: "Declares compatibility",
        compatibility: {
          openomni: ">=1.0.0",
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.compatibility?.openomni).toBe(">=1.0.0");
      }
    });

    it("rejects manifest missing required id", () => {
      expect(
        Extension.Manifest.safeParse({ name: "No ID", version: "1.0.0", description: "x" }).success,
      ).toBe(false);
    });

    it("rejects manifest missing required name", () => {
      expect(
        Extension.Manifest.safeParse({ id: "ext", version: "1.0.0", description: "x" }).success,
      ).toBe(false);
    });

    it("rejects manifest missing required version", () => {
      expect(
        Extension.Manifest.safeParse({ id: "ext", name: "Ext", description: "x" }).success,
      ).toBe(false);
    });

    it("rejects manifest missing required description", () => {
      expect(
        Extension.Manifest.safeParse({ id: "ext", name: "Ext", version: "1.0.0" }).success,
      ).toBe(false);
    });

    it("rejects manifest with invalid skill layer in contributes", () => {
      expect(
        Extension.Manifest.safeParse({
          id: "ext-bad",
          name: "Bad",
          version: "1.0.0",
          description: "x",
          contributes: {
            skills: [
              {
                id: "s",
                name: "S",
                description: "d",
                scope: "local",
                layer: "invalid_layer",
                path: "/p",
              },
            ],
          },
        }).success,
      ).toBe(false);
    });

    it("rejects manifest with invalid MCP transport in contributes", () => {
      expect(
        Extension.Manifest.safeParse({
          id: "ext-bad",
          name: "Bad",
          version: "1.0.0",
          description: "x",
          contributes: {
            mcpServers: [{ name: "bad", transport: "websocket" }],
          },
        }).success,
      ).toBe(false);
    });
  });

  describe("Extension.InstallRequest", () => {
    it("parses a minimal install request", () => {
      const result = Extension.InstallRequest.safeParse({
        manifest: {
          id: "ext-install",
          name: "Install Me",
          version: "1.0.0",
          description: "Ready to install",
        },
        requestedBy: "user:admin",
        requestedAt: 1714809600000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.manifest.id).toBe("ext-install");
        expect(result.data.requestedBy).toBe("user:admin");
        expect(result.data.reason).toBeUndefined();
      }
    });

    it("parses an install request with reason", () => {
      const result = Extension.InstallRequest.safeParse({
        manifest: {
          id: "ext-install",
          name: "Install Me",
          version: "1.0.0",
          description: "Ready to install",
        },
        requestedBy: "persona:main",
        requestedAt: 1714809600000,
        reason: "needed for SNS workflow",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reason).toBe("needed for SNS workflow");
      }
    });

    it("rejects install request missing manifest", () => {
      expect(
        Extension.InstallRequest.safeParse({
          requestedBy: "user:admin",
          requestedAt: 1714809600000,
        }).success,
      ).toBe(false);
    });

    it("rejects install request missing requestedBy", () => {
      expect(
        Extension.InstallRequest.safeParse({
          manifest: { id: "ext", name: "E", version: "1.0.0", description: "d" },
          requestedAt: 1714809600000,
        }).success,
      ).toBe(false);
    });
  });

  describe("Extension.Events", () => {
    it("Proposed descriptor has correct name and parses base payload", () => {
      expect(Extension.Events.Proposed.name).toBe("extension.proposed");
      const result = Extension.Events.Proposed.schema.safeParse(BASE_EVENT);
      expect(result.success).toBe(true);
    });

    it("Approved descriptor has correct name and parses base payload", () => {
      expect(Extension.Events.Approved.name).toBe("extension.approved");
      const result = Extension.Events.Approved.schema.safeParse(BASE_EVENT);
      expect(result.success).toBe(true);
    });

    it("Staged descriptor has correct name and parses base payload", () => {
      expect(Extension.Events.Staged.name).toBe("extension.staged");
      const result = Extension.Events.Staged.schema.safeParse(BASE_EVENT);
      expect(result.success).toBe(true);
    });

    it("Installed descriptor has correct name and parses base payload", () => {
      expect(Extension.Events.Installed.name).toBe("extension.installed");
      const result = Extension.Events.Installed.schema.safeParse(BASE_EVENT);
      expect(result.success).toBe(true);
    });

    it("Enabled descriptor has correct name and parses base payload", () => {
      expect(Extension.Events.Enabled.name).toBe("extension.enabled");
      const result = Extension.Events.Enabled.schema.safeParse(BASE_EVENT);
      expect(result.success).toBe(true);
    });

    it("Disabled descriptor has correct name and parses base payload", () => {
      expect(Extension.Events.Disabled.name).toBe("extension.disabled");
      const result = Extension.Events.Disabled.schema.safeParse(BASE_EVENT);
      expect(result.success).toBe(true);
    });

    it("RolledBack descriptor has correct name and requires fromVersion", () => {
      expect(Extension.Events.RolledBack.name).toBe("extension.rolled_back");

      const withFrom = Extension.Events.RolledBack.schema.safeParse({
        ...BASE_EVENT,
        fromVersion: "2.0.0",
      });
      expect(withFrom.success).toBe(true);
      if (withFrom.success) {
        expect(withFrom.data.fromVersion).toBe("2.0.0");
      }

      const withoutFrom = Extension.Events.RolledBack.schema.safeParse(BASE_EVENT);
      expect(withoutFrom.success).toBe(false);
    });

    it("Uninstalled descriptor has correct name and parses base payload", () => {
      expect(Extension.Events.Uninstalled.name).toBe("extension.uninstalled");
      const result = Extension.Events.Uninstalled.schema.safeParse(BASE_EVENT);
      expect(result.success).toBe(true);
    });

    it("Failed descriptor has correct name and requires error field", () => {
      expect(Extension.Events.Failed.name).toBe("extension.failed");

      const withError = Extension.Events.Failed.schema.safeParse({
        ...BASE_EVENT,
        error: "checksum mismatch",
      });
      expect(withError.success).toBe(true);
      if (withError.success) {
        expect(withError.data.error).toBe("checksum mismatch");
      }

      const withoutError = Extension.Events.Failed.schema.safeParse(BASE_EVENT);
      expect(withoutError.success).toBe(false);
    });

    it("all event base payloads accept optional reason", () => {
      const withReason = { ...BASE_EVENT, reason: "manual override" };
      expect(Extension.Events.Proposed.schema.safeParse(withReason).success).toBe(true);
      expect(Extension.Events.Approved.schema.safeParse(withReason).success).toBe(true);
      expect(Extension.Events.Disabled.schema.safeParse(withReason).success).toBe(true);
    });

    it("base event payloads reject missing required fields", () => {
      expect(
        Extension.Events.Installed.schema.safeParse({
          extensionId: "ext-test",
          version: "1.0.0",
        }).success,
      ).toBe(false);
    });
  });
});
