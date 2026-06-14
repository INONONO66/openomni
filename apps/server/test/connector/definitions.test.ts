import { describe, expect, test } from "bun:test";
import { AppConnector } from "@openomni/protocol";
import { ServerConnectorDefinitions } from "../../src/connector/index.js";

describe("ServerConnectorDefinitions", () => {
  test("lists the server-owned connector endpoint definitions", () => {
    // Given
    const connectors = ServerConnectorDefinitions.list();

    // When
    const ids = connectors.map((connector) => connector.id);

    // Then
    expect(ids).toEqual(["app.claude-code", "app.codex", "app.opencode"]);
  });

  test("keeps every server connector inside the public AppConnector ABI", () => {
    // Given
    const connectors = ServerConnectorDefinitions.list();

    // When / Then
    for (const connector of connectors) {
      const result = AppConnector.Definition.safeParse(connector);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.profile.kind).toBe("connector_endpoint");
        expect(result.data.profile.initialAutonomy).toBe("approval_required");
        expect(result.data.driver.submit).toEqual({ mode: "spawn", ack: "accepted" });
        expect(result.data.detect.testedVersions.length).toBeGreaterThan(0);
        expect(result.data.evidence.emits).toContain("exit_code");
        expect(result.data.evidence.emits).toContain("log_event");
        expect(result.data.requires.capabilities).toContain("git");
      }
    }
  });

  test("declares verified headless spawn entrypoints for installed connector endpoints", () => {
    // Given
    const claude = ServerConnectorDefinitions.get("app.claude-code");
    const codex = ServerConnectorDefinitions.get("app.codex");
    const opencode = ServerConnectorDefinitions.get("app.opencode");

    // When / Then
    expect(claude?.spawn).toMatchObject({
      command: "claude",
      args: ["--print", "--permission-mode", "acceptEdits", "{{prompt}}"],
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    });
    expect(codex?.spawn).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "--sandbox", "workspace-write", "-C", "{{worktree}}", "{{prompt}}"],
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    });
    expect(opencode?.spawn).toMatchObject({
      command: "opencode",
      args: ["run", "--print-logs", "--format", "json", "{{prompt}}"],
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    });
  });

  test("matches observed local version output with each drift guard pattern", () => {
    // Given
    const versionOutputById: Readonly<Record<string, string>> = {
      "app.claude-code": "2.1.173 (Claude Code)",
      "app.codex": "codex-cli 0.139.0",
      "app.opencode": "1.17.4",
    };

    // When / Then
    for (const connector of ServerConnectorDefinitions.list()) {
      const versionOutput = versionOutputById[connector.id];
      const versionPattern = connector.detect.versionPattern;

      expect(versionOutput).toBeDefined();
      expect(versionPattern).toBeDefined();

      if (versionOutput !== undefined && versionPattern !== undefined) {
        const match = new RegExp(versionPattern).exec(versionOutput);

        expect(match?.groups?.version).toBeTruthy();
      }
    }
  });

  test("keeps server tested version ranges inside discovery grammar", () => {
    // Given / When / Then
    for (const connector of ServerConnectorDefinitions.list()) {
      const constraints = connector.detect.testedVersions
        .split(" ")
        .filter((constraint) => constraint.length > 0);

      expect(constraints.length).toBeGreaterThan(0);
      for (const constraint of constraints) {
        expect(constraint).toMatch(/^(>=|<)\d+\.\d+\.\d+$/);
      }
    }
  });

  test("returns defensive copies of server connector data", () => {
    // Given
    const connectors = ServerConnectorDefinitions.list();
    const firstConnector = connectors[0];
    const codexConnector = ServerConnectorDefinitions.get("app.codex");

    // When
    if (firstConnector === undefined || codexConnector === undefined) {
      throw new Error("expected server connector copies");
    }
    const codexArgs = codexConnector.spawn.args;
    if (codexArgs === undefined) {
      throw new Error("expected Codex spawn args");
    }
    firstConnector.name = "Mutated";
    firstConnector.profile.taskTypes.push("mutated.task");
    codexArgs.push("--mutated");

    // Then
    const storedConnector = ServerConnectorDefinitions.get("app.claude-code");
    const storedCodexConnector = ServerConnectorDefinitions.get("app.codex");

    expect(storedConnector?.name).toBe("Claude Code");
    expect(storedConnector?.profile.taskTypes).not.toContain("mutated.task");
    expect(storedCodexConnector?.spawn.args).not.toContain("--mutated");
  });

  test("returns undefined for an unknown server connector id", () => {
    // Given / When
    const connector = ServerConnectorDefinitions.get("app.unknown");

    // Then
    expect(connector).toBeUndefined();
  });
});
