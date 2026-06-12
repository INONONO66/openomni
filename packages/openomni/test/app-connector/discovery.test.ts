import { describe, expect, test } from "bun:test";
import type { AppConnector } from "@openomni/protocol";
import { AppConnectorDiscovery } from "../../src/index.js";

describe("AppConnectorDiscovery", () => {
  test("discovers installed built-in connector candidates from detect commands", async () => {
    // Given
    const detections: Readonly<Record<string, string>> = {
      "app.claude-code": "2.1.173 (Claude Code)\n",
      "app.codex": "codex-cli 0.139.0\n",
      "app.opencode": "1.17.4\n",
    };

    // When
    const candidates = await AppConnectorDiscovery.discoverBuiltIns({
      runDetectCommand: async (connector) => ({
        exitCode: 0,
        stdout: detections[connector.id] ?? "",
        stderr: "",
      }),
    });

    // Then
    expect(candidates.map((candidate) => candidate.status)).toEqual([
      "available",
      "available",
      "available",
    ]);
    expect(candidates.map((candidate) => candidate.version)).toEqual([
      "2.1.173",
      "0.139.0",
      "1.17.4",
    ]);
  });

  test("reports missing and unsupported connector candidates without throwing", async () => {
    // Given / When
    const candidates = await AppConnectorDiscovery.discoverBuiltIns({
      runDetectCommand: async (connector) => {
        if (connector.id === "app.claude-code") {
          return {
            exitCode: 127,
            stdout: "",
            stderr: "command not found",
          };
        }
        if (connector.id === "app.codex") {
          return {
            exitCode: 0,
            stdout: "codex-cli 0.138.0",
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: "not a semantic version",
          stderr: "",
        };
      },
    });

    // Then
    expect(candidates.map((candidate) => [candidate.id, candidate.status])).toEqual([
      ["app.claude-code", "missing"],
      ["app.codex", "unsupported_version"],
      ["app.opencode", "detect_failed"],
    ]);
  });

  test("reports missing when the detect command cannot be spawned", async () => {
    // Given / When
    const candidates = await AppConnectorDiscovery.discoverBuiltIns({
      connectors: [
        {
          ...AppConnectorDiscoveryFixtures.codexConnector,
          detect: {
            ...AppConnectorDiscoveryFixtures.codexConnector.detect,
            command: "openomni-missing-command",
          },
        },
      ],
      runDetectCommand: async () => {
        throw new Error('Executable not found in $PATH: "openomni-missing-command"');
      },
    });

    // Then
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status).toBe("missing");
  });

  test("times out a hung default detect command as a failed candidate", async () => {
    // Given / When
    const candidates = await AppConnectorDiscovery.discoverBuiltIns({
      connectors: [
        {
          ...AppConnectorDiscoveryFixtures.codexConnector,
          detect: {
            ...AppConnectorDiscoveryFixtures.codexConnector.detect,
            command: "bun",
            args: ["-e", "setTimeout(() => {}, 1_000)"],
          },
        },
      ],
      detectTimeoutMs: 10,
    });

    // Then
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status).toBe("detect_failed");
    expect(candidates[0]?.diagnostic).toContain("timed out");
  });
});

namespace AppConnectorDiscoveryFixtures {
  export const codexConnector = {
    id: "app.codex",
    name: "Codex CLI",
    version: "1.0.0",
    description: "Runs Codex CLI as an installed local CLI agent",
    detect: {
      command: "codex",
      args: ["--version"],
      versionPattern: "^codex-cli (?<version>\\d+\\.\\d+\\.\\d+)$",
      testedVersions: ">=0.139.0 <0.140.0",
    },
    spawn: {
      command: "codex",
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    },
    logs: {
      kind: "jsonl",
      path: "stdout",
      eventTimeField: "timestamp",
      messageField: "message",
    },
    questionBridge: {
      kind: "none",
    },
    evidence: {
      emits: ["exit_code"],
    },
    requires: {
      capabilities: ["git"],
      permissions: [{ action: "tool.call" }],
    },
    profile: {
      executorKind: "local_cli_agent",
      taskTypes: ["code.change"],
      defaultTimeoutMs: 600_000,
      defaultMaxAttempts: 2,
      initialAutonomy: "approval_required",
    },
  } satisfies AppConnector.Definition;
}
