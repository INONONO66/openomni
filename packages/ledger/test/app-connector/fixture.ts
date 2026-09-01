import type { AppConnector } from "@openomni/protocol";

function connectorDefinition(): AppConnector.Definition {
  return {
    id: "app.example-worker",
    name: "Example Worker",
    version: "1.0.0",
    description: "Runs Example Worker as an installed connector endpoint",
    detect: {
      command: "codex",
      args: ["--version"],
      versionPattern: "^example-worker (?<version>\\d+\\.\\d+\\.\\d+)$",
      testedVersions: ">=0.139.0 <0.140.0",
    },
    spawn: {
      command: "codex",
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    },
    questionBridge: { kind: "none" },
    evidence: { emits: ["exit_code"] },
    requires: {
      credentials: [],
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
    },
    driver: {
      provider: "codex",
      install: { scopes: ["user", "workspace"], hooks: [], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["submitted", "accepted", "running", "completed"],
      emits: ["exit_code"],
    },
    profile: {
      kind: "connector_endpoint",
      taskTypes: ["code.change"],
      initialAutonomy: "approval_required",
    },
  };
}

export function installation(id: string, createdAt = 100): AppConnector.Installation {
  const definition = connectorDefinition();
  return {
    id,
    connectorId: definition.id,
    connectorVersion: definition.version,
    endpointId: `endpoint:${id}`,
    definition,
    detectedVersion: "0.139.0",
    status: "registered",
    registeredBy: "act_owner",
    createdAt,
    updatedAt: createdAt,
  };
}
