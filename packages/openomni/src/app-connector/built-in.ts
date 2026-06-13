import { AppConnector } from "@openomni/protocol";

const evidenceEmits = [
  "exit_code",
  "diff",
  "test_result",
  "tool_call",
  "token_usage",
  "log_event",
] satisfies AppConnector.EvidenceEmitter[];

const codeTaskTypes = ["code.change", "code.review"] satisfies string[];
const defaultCapabilities = ["git", "network", "filesystem.write"] satisfies string[];
const defaultStallTimeoutMs = 300_000;

const claudeCodeConnector: AppConnector.Definition = {
  id: "app.claude-code",
  name: "Claude Code",
  version: "1.0.0",
  description: "Runs Claude Code as an installed local CLI agent",
  detect: {
    command: "claude",
    args: ["--version"],
    versionPattern: "^(?<version>\\d+\\.\\d+\\.\\d+) \\(Claude Code\\)$",
    testedVersions: ">=2.1.0 <2.2.0",
  },
  spawn: {
    command: "claude",
    args: ["--print", "--permission-mode", "acceptEdits", "{{prompt}}"],
    promptArgument: "{{prompt}}",
    cwd: "{{worktree}}",
    timeoutMs: 600_000,
    stallTimeoutMs: defaultStallTimeoutMs,
  },
  logs: {
    kind: "jsonl",
    path: "~/.claude/projects/{{workspaceHash}}/*.jsonl",
    eventTimeField: "timestamp",
    messageField: "message",
  },
  questionBridge: {
    kind: "hook",
    command: "openomni-claude-permission-hook",
    promptField: "prompt",
    responseMode: "stdout",
  },
  evidence: {
    emits: evidenceEmits,
    completionReport: {
      finalMessage: "stdout",
      artifactGlobs: ["*.patch", "test-results/*.json"],
    },
  },
  requires: {
    capabilities: defaultCapabilities,
    permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
  },
  profile: {
    executorKind: "local_cli_agent",
    taskTypes: codeTaskTypes,
    defaultTimeoutMs: 600_000,
    defaultMaxAttempts: 2,
    initialAutonomy: "approval_required",
  },
};

const codexConnector: AppConnector.Definition = {
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
    args: ["exec", "--json", "--sandbox", "workspace-write", "-C", "{{worktree}}", "{{prompt}}"],
    promptArgument: "{{prompt}}",
    cwd: "{{worktree}}",
    timeoutMs: 600_000,
    stallTimeoutMs: defaultStallTimeoutMs,
  },
  logs: {
    kind: "jsonl",
    path: "stdout",
    eventTimeField: "timestamp",
    messageField: "msg",
  },
  questionBridge: {
    kind: "none",
  },
  evidence: {
    emits: evidenceEmits,
    completionReport: {
      finalMessage: "stdout",
      artifactGlobs: ["*.patch", "test-results/*.json"],
    },
  },
  requires: {
    capabilities: defaultCapabilities,
    permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
  },
  profile: {
    executorKind: "local_cli_agent",
    taskTypes: codeTaskTypes,
    defaultTimeoutMs: 600_000,
    defaultMaxAttempts: 2,
    initialAutonomy: "approval_required",
  },
};

const opencodeConnector: AppConnector.Definition = {
  id: "app.opencode",
  name: "OpenCode",
  version: "1.0.0",
  description: "Runs OpenCode as an installed local CLI agent",
  detect: {
    command: "opencode",
    args: ["--version"],
    versionPattern: "^(?<version>\\d+\\.\\d+\\.\\d+)$",
    testedVersions: ">=1.17.0 <1.18.0",
  },
  spawn: {
    command: "opencode",
    args: ["run", "--print-logs", "--format", "json", "{{prompt}}"],
    promptArgument: "{{prompt}}",
    cwd: "{{worktree}}",
    timeoutMs: 600_000,
    stallTimeoutMs: defaultStallTimeoutMs,
  },
  logs: {
    kind: "stream_json",
    path: "stdout",
    eventTimeField: "time",
    messageField: "message",
  },
  questionBridge: {
    kind: "none",
  },
  evidence: {
    emits: evidenceEmits,
    completionReport: {
      finalMessage: "stdout",
      artifactGlobs: ["*.patch", "test-results/*.json"],
    },
  },
  requires: {
    capabilities: defaultCapabilities,
    permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
  },
  profile: {
    executorKind: "local_cli_agent",
    taskTypes: codeTaskTypes,
    defaultTimeoutMs: 600_000,
    defaultMaxAttempts: 2,
    initialAutonomy: "approval_required",
  },
};

const builtInConnectors = [
  claudeCodeConnector,
  codexConnector,
  opencodeConnector,
] satisfies readonly AppConnector.Definition[];

function cloneConnector(connector: AppConnector.Definition): AppConnector.Definition {
  return AppConnector.Definition.parse(structuredClone(connector));
}

export namespace BuiltInAppConnectors {
  export function list(): readonly AppConnector.Definition[] {
    return builtInConnectors.map(cloneConnector);
  }

  export function get(id: string): AppConnector.Definition | undefined {
    const connector = builtInConnectors.find((candidate) => candidate.id === id);
    return connector === undefined ? undefined : cloneConnector(connector);
  }
}
