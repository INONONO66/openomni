import type { AppConnector } from "@openomni/protocol";
import { ServerConnectorDefinitions } from "./definitions.js";

type ConnectorVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const DEFAULT_DETECT_TIMEOUT_MS = 10_000;

export type ServerConnectorDiscoveryStatus =
  | "available"
  | "missing"
  | "unsupported_version"
  | "detect_failed";

export interface DetectCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DiscoveryCandidate {
  readonly id: string;
  readonly name: string;
  readonly connector: AppConnector.Definition;
  readonly status: ServerConnectorDiscoveryStatus;
  readonly version?: string;
  readonly testedVersions: string;
  readonly diagnostic?: string;
}

export interface ServerConnectorDiscoveryOptions {
  readonly connectors?: readonly AppConnector.Definition[];
  readonly detectTimeoutMs?: number;
  readonly runDetectCommand?: DetectCommandRunner;
}

export type DetectCommandRunner = (
  connector: AppConnector.Definition,
) => Promise<DetectCommandResult>;

export namespace ServerConnectorDiscovery {
  export async function discover(
    options: ServerConnectorDiscoveryOptions = {},
  ): Promise<readonly DiscoveryCandidate[]> {
    const connectors = options.connectors ?? ServerConnectorDefinitions.list();
    const detectTimeoutMs = options.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
    const runDetectCommand =
      options.runDetectCommand ??
      ((connector) => runDefaultDetectCommand(connector, detectTimeoutMs));
    return Promise.all(
      connectors.map((connector) => discoverConnector(connector, runDetectCommand)),
    );
  }
}

async function discoverConnector(
  connector: AppConnector.Definition,
  runDetectCommand: DetectCommandRunner,
): Promise<DiscoveryCandidate> {
  try {
    const result = await runDetectCommand(connector);
    if (result.exitCode === 127) {
      return candidate(connector, "missing", { diagnostic: result.stderr });
    }
    if (result.exitCode !== 0) {
      return candidate(connector, "detect_failed", { diagnostic: result.stderr });
    }

    const detectedVersion = extractVersion(connector, result.stdout);
    if (detectedVersion === undefined) {
      return candidate(connector, "detect_failed", {
        diagnostic: "version output did not match connector pattern",
      });
    }
    if (!isVersionInRange(detectedVersion, connector.detect.testedVersions)) {
      return candidate(connector, "unsupported_version", { version: detectedVersion });
    }
    return candidate(connector, "available", { version: detectedVersion });
  } catch (error) {
    if (error instanceof Error) {
      if (isCommandNotFoundError(error)) {
        return candidate(connector, "missing", { diagnostic: error.message });
      }
      return candidate(connector, "detect_failed", { diagnostic: error.message });
    }
    throw error;
  }
}

function candidate(
  connector: AppConnector.Definition,
  status: ServerConnectorDiscoveryStatus,
  details: Pick<DiscoveryCandidate, "diagnostic" | "version"> = {},
): DiscoveryCandidate {
  return {
    id: connector.id,
    name: connector.name,
    connector,
    status,
    testedVersions: connector.detect.testedVersions,
    ...details,
  };
}

function extractVersion(connector: AppConnector.Definition, stdout: string): string | undefined {
  const versionPattern = connector.detect.versionPattern;
  if (versionPattern === undefined) {
    return undefined;
  }
  const match = new RegExp(versionPattern).exec(stdout.trim());
  const version = match?.groups?.version;
  return version === "" ? undefined : version;
}

function isVersionInRange(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);
  if (parsedVersion === undefined) {
    return false;
  }

  for (const constraint of range.split(" ").filter((part) => part.length > 0)) {
    if (!satisfiesConstraint(parsedVersion, constraint)) {
      return false;
    }
  }
  return true;
}

function satisfiesConstraint(version: ConnectorVersion, constraint: string): boolean {
  const operator = constraint.startsWith(">=")
    ? ">="
    : constraint.startsWith("<")
      ? "<"
      : undefined;
  if (operator === undefined) {
    return false;
  }

  const target = parseVersion(constraint.slice(operator.length));
  if (target === undefined) {
    return false;
  }

  const comparison = compareVersions(version, target);
  if (operator === ">=") {
    return comparison >= 0;
  }
  return comparison < 0;
}

function parseVersion(version: string): ConnectorVersion | undefined {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  if (parts.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }
  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10));
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    !Number.isInteger(patch)
  ) {
    return undefined;
  }
  return { major, minor, patch };
}

function compareVersions(left: ConnectorVersion, right: ConnectorVersion): number {
  const majorComparison = left.major - right.major;
  if (majorComparison !== 0) {
    return majorComparison;
  }
  const minorComparison = left.minor - right.minor;
  if (minorComparison !== 0) {
    return minorComparison;
  }
  return left.patch - right.patch;
}

function isCommandNotFoundError(error: Error): boolean {
  return (
    error.message.includes("ENOENT") ||
    error.message.includes("No such file or directory") ||
    error.message.includes("Executable not found in $PATH")
  );
}

async function runDefaultDetectCommand(
  connector: AppConnector.Definition,
  timeoutMs: number,
): Promise<DetectCommandResult> {
  const proc = Bun.spawn([connector.detect.command, ...(connector.detect.args ?? [])], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      return {
        exitCode: 1,
        stdout,
        stderr: stderr || `detect command timed out after ${timeoutMs}ms`,
      };
    }

    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
