import { describe, expect, test } from "bun:test";
import { AppConnector } from "../src/index.js";

const it = test;

function issuePaths(error: { issues: Array<{ path: PropertyKey[] }> }): string[] {
  return error.issues.map((issue) => issue.path.map((segment) => String(segment)).join("."));
}

function validDriver(): Record<string, unknown> {
  return {
    provider: "example-provider",
    install: {
      scopes: ["user", "workspace"],
      hooks: ["permission"],
      plugins: [],
    },
    submit: {
      mode: "spawn",
      ack: "accepted",
    },
    observedEvents: ["submitted", "accepted", "running", "completed"],
    emits: ["exit_code", "diff", "test_result", "tool_call", "token_usage"],
  };
}

function validConnector(): Record<string, unknown> {
  return {
    id: "app.example-connector",
    name: "Example Connector",
    version: "1.0.0",
    description: "Runs Example Connector as an installed CLI application",
    detect: {
      command: "example-cli",
      args: ["--version"],
      versionPattern: "example-provider (?<version>\\d+\\.\\d+\\.\\d+)",
      testedVersions: ">=1.0.0 <2.0.0",
    },
    spawn: {
      command: "example-cli",
      args: ["--print", "{{prompt}}"],
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
      timeoutMs: 600_000,
    },
    logs: {
      kind: "jsonl",
      path: "~/.example-connector/projects/{{workspaceHash}}/*.jsonl",
      eventTimeField: "timestamp",
      messageField: "message",
    },
    questionBridge: {
      kind: "hook",
      command: "openomni-example-permission-hook",
      promptField: "prompt",
      responseMode: "stdout",
    },
    evidence: {
      emits: ["exit_code", "diff", "test_result", "tool_call", "token_usage"],
      completionReport: {
        finalMessage: "stdout",
        artifactGlobs: ["*.patch", "test-results/*.json"],
      },
    },
    requires: {
      credentials: ["ANTHROPIC_API_KEY"],
      capabilities: ["git", "network", "filesystem.write"],
      permissions: [{ action: "tool.call", allowlist: ["bash", "edit"] }],
    },
    driver: validDriver(),
    profile: {
      kind: "connector_endpoint",
      taskTypes: ["code.change", "code.review"],
      defaultTimeoutMs: 600_000,
      defaultMaxAttempts: 2,
      initialAutonomy: "approval_required",
    },
  };
}

describe("AppConnector protocol domain", () => {
  describe("AppConnector.Installation", () => {
    it("parses a registered connector installation record", () => {
      // Given
      const installation = {
        id: "install-app-codex",
        connectorId: "app.example-connector",
        connectorVersion: "1.0.0",
        endpointId: "endpoint:install-app-codex",
        definition: validConnector(),
        detectedVersion: "0.139.0",
        status: "registered",
        registeredBy: "act_owner",
        consent: {
          grantedBy: "act_owner",
          grantedAt: 200,
          credentials: ["ANTHROPIC_API_KEY"],
          capabilities: ["git"],
          permissions: [{ action: "tool.call", allowlist: ["bash"] }],
        },
        createdAt: 100,
        updatedAt: 100,
      };

      // When
      const result = AppConnector.Installation.safeParse(installation);

      // Then
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connectorId).toBe("app.example-connector");
        expect(result.data.status).toBe("registered");
        expect(result.data.endpointId).toBe("endpoint:install-app-codex");
        expect(result.data.consent?.credentials).toEqual(["ANTHROPIC_API_KEY"]);
        expect(result.data.definition.profile.kind).toBe("connector_endpoint");
      }
    });

    it("rejects the duplicate testedVersions field", () => {
      const installation = {
        id: "install-app-codex",
        connectorId: "app.example-connector",
        connectorVersion: "1.0.0",
        endpointId: "endpoint:install-app-codex",
        definition: validConnector(),
        testedVersions: ">=0.139.0 <0.140.0",
        status: "registered",
        registeredBy: "act_owner",
        createdAt: 100,
        updatedAt: 100,
      };

      expect(AppConnector.Installation.safeParse(installation).success).toBe(false);
    });

    it("rejects installation records whose embedded definition does not match the connector id", () => {
      // Given
      const installation = {
        id: "install-app-codex",
        connectorId: "app.example-worker",
        connectorVersion: "1.0.0",
        endpointId: "endpoint:install-app-codex",
        definition: { ...validConnector(), id: "app.other" },
        status: "registered",
        registeredBy: "act_owner",
        createdAt: 100,
        updatedAt: 100,
      };

      // When
      const result = AppConnector.Installation.safeParse(installation);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = issuePaths(result.error);
        expect(paths.includes("definition.id")).toBe(true);
      }
    });

    it("rejects installation records whose embedded definition does not match the connector version", () => {
      // Given
      const installation = {
        id: "install-app-codex",
        connectorId: "app.example-connector",
        connectorVersion: "2.0.0",
        endpointId: "endpoint:install-app-codex",
        definition: validConnector(),
        status: "registered",
        registeredBy: "act_owner",
        createdAt: 100,
        updatedAt: 100,
      };

      // When
      const result = AppConnector.Installation.safeParse(installation);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = issuePaths(result.error);
        expect(paths.includes("definition.version")).toBe(true);
      }
    });

    it("rejects enabled installation records without owner consent", () => {
      // Given
      const installation = {
        id: "install-app-codex",
        connectorId: "app.example-connector",
        connectorVersion: "1.0.0",
        endpointId: "endpoint:install-app-codex",
        definition: validConnector(),
        status: "enabled",
        registeredBy: "act_owner",
        createdAt: 100,
        updatedAt: 100,
      };

      // When
      const result = AppConnector.Installation.safeParse(installation);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = issuePaths(result.error);
        expect(paths.includes("consent")).toBe(true);
      }
    });
  });

  describe("AppConnector.Definition", () => {
    it("parses a declarative installed app connector", () => {
      // Given
      const connector = validConnector();

      // When
      const result = AppConnector.Definition.safeParse(connector);

      // Then
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("app.example-connector");
        expect(result.data.detect.testedVersions).toBe(">=1.0.0 <2.0.0");
        expect(result.data.spawn.promptArgument).toBe("{{prompt}}");
        expect(result.data.driver.submit.ack).toBe("accepted");
        expect(result.data.profile.kind).toBe("connector_endpoint");
      }
    });

    it("accepts optional connector wires without requiring runtime code", () => {
      // Given
      const connector = {
        id: "app.minimal",
        name: "Minimal App",
        version: "0.1.0",
        description: "Minimal connector",
        detect: { command: "minimal", testedVersions: "*" },
        spawn: { command: "minimal", args: ["run"] },
        driver: validDriver(),
        evidence: { emits: ["exit_code"] },
        requires: {},
        profile: { kind: "connector_endpoint", taskTypes: ["read.only"] },
      };

      // When
      const result = AppConnector.Definition.safeParse(connector);

      // Then
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logs).toBe(undefined);
        expect(result.data.questionBridge).toBe(undefined);
        expect(result.data.requires.credentials).toBe(undefined);
        expect(result.data.requires.capabilities).toBe(undefined);
      }
    });

    it("rejects connectors missing the required public ABI sections", () => {
      // Given
      const connector = {
        id: "app.incomplete",
        name: "Incomplete",
        version: "1.0.0",
        description: "Missing spawn/evidence/requires/profile",
        detect: { command: "incomplete", testedVersions: "*" },
      };

      // When
      const result = AppConnector.Definition.safeParse(connector);

      // Then
      expect(result.success).toBe(false);
    });

    it("rejects unsupported evidence emitters", () => {
      // Given
      const connector = validConnector();

      // When
      const result = AppConnector.Definition.safeParse({
        ...connector,
        evidence: { emits: ["screenshot"] },
      });

      // Then
      expect(result.success).toBe(false);
    });

    it("accepts templated completion read-back request builders", () => {
      // Given
      const connector = validConnector();

      // When
      const result = AppConnector.Definition.safeParse({
        ...connector,
        evidence: {
          emits: ["exit_code"],
          completionReport: {
            finalMessage: "stdout",
            readBackRequests: [
              {
                claimIndex: 0,
                criterionIndex: 0,
                request: {
                  kind: "citation_match",
                  target: "{{output.url}}",
                  quotedText: "{{output.marker}}",
                },
              },
              {
                claimIndex: 1,
                criterionIndex: 1,
                request: {
                  kind: "api_query",
                  target: "{{output.apiUrl}}",
                  method: "HEAD",
                },
              },
            ],
          },
        },
      });

      // Then
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.evidence.completionReport?.readBackRequests?.length).toBe(2);
      }
    });

    it("rejects unsupported completion read-back builder methods", () => {
      // Given
      const connector = validConnector();

      // When
      const result = AppConnector.Definition.safeParse({
        ...connector,
        evidence: {
          emits: ["exit_code"],
          completionReport: {
            finalMessage: "stdout",
            readBackRequests: [
              {
                claimIndex: 0,
                criterionIndex: 0,
                request: {
                  kind: "api_query",
                  target: "{{output.apiUrl}}",
                  method: "POST",
                },
              },
            ],
          },
        },
      });

      // Then
      expect(result.success).toBe(false);
    });

    it("rejects invalid runtime limits", () => {
      // Given
      const connector = validConnector();

      // When
      const result = AppConnector.Definition.safeParse({
        ...connector,
        profile: {
          kind: "connector_endpoint",
          taskTypes: ["code.change"],
          defaultTimeoutMs: 0,
          defaultMaxAttempts: 0,
        },
      });

      // Then
      expect(result.success).toBe(false);
    });

    it("rejects log kind field mismatches", () => {
      // Given
      const connector = validConnector();

      // When
      const textResult = AppConnector.Definition.safeParse({
        ...connector,
        logs: {
          kind: "text",
          path: "/tmp/app.log",
          eventTimeField: "timestamp",
        },
      });
      const jsonlResult = AppConnector.Definition.safeParse({
        ...connector,
        logs: {
          kind: "jsonl",
          path: "/tmp/app.log",
          eventTimeField: "timestamp",
        },
      });

      // Then
      expect(textResult.success).toBe(false);
      expect(jsonlResult.success).toBe(false);
    });

    it("rejects question bridge kind field mismatches", () => {
      // Given
      const connector = validConnector();

      // When
      const noneResult = AppConnector.Definition.safeParse({
        ...connector,
        questionBridge: {
          kind: "none",
          command: "should-not-run",
        },
      });
      const stdioResult = AppConnector.Definition.safeParse({
        ...connector,
        questionBridge: {
          kind: "stdio",
          command: "should-not-run",
        },
      });
      const hookResult = AppConnector.Definition.safeParse({
        ...connector,
        questionBridge: {
          kind: "hook",
          responseMode: "stdout",
        },
      });

      // Then
      expect(noneResult.success).toBe(false);
      expect(stdioResult.success).toBe(false);
      expect(hookResult.success).toBe(false);
    });

    it("rejects unknown connector keys", () => {
      // Given
      const connector = validConnector();

      // When
      const result = AppConnector.Definition.safeParse({
        ...connector,
        runtimeCode: "not allowed in a declarative connector",
      });

      // Then
      expect(result.success).toBe(false);
    });
  });
});
