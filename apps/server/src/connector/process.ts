import type { AppConnector } from "@openomni/protocol";
import {
  type ConnectorTemplateValues,
  renderConnectorArgs,
  renderConnectorCwd,
  renderConnectorEnv,
  renderConnectorTemplate,
} from "./env.js";
import { readConnectorLogSnapshot, type ConnectorLogSnapshot } from "./log-path.js";
import {
  startConnectorQuestionBridgeServer,
  type ConnectorQuestionBridgeHandler,
} from "./question-bridge.js";

export interface ConnectorProcessOutcome {
  readonly status: "succeeded" | "failed" | "interrupted";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly interruptionReason?: "timeout" | "stall_timeout";
}

export interface ConnectorProcessResult {
  readonly outcome: ConnectorProcessOutcome;
  readonly redactions: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_LOG_POLL_MS = 25;
const MAX_LOG_POLL_MS = 1_000;

function terminateProcess(proc: { readonly pid: number; kill(): void }): void {
  try {
    process.kill(-proc.pid, "SIGTERM");
    return;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  proc.kill();
}

function interruptionMessage(reason: "timeout" | "stall_timeout", timeoutMs: number): string {
  if (reason === "stall_timeout") {
    return `connector process stalled after ${timeoutMs}ms without output`;
  }
  return `connector process timed out after ${timeoutMs}ms`;
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  onActivity: () => void,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.length > 0) onActivity();
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function questionBridgeEnabled(questionBridge: AppConnector.QuestionBridge | undefined): boolean {
  return questionBridge !== undefined && questionBridge.kind !== "none";
}

function effectiveQuestionBridge(
  questionBridge: AppConnector.QuestionBridge | undefined,
  bridgeStarted: boolean,
): AppConnector.QuestionBridge | undefined {
  if (!questionBridgeEnabled(questionBridge)) return questionBridge;
  return bridgeStarted ? questionBridge : { kind: "none" };
}

function logPollIntervalMs(stallTimeoutMs: number): number {
  return Math.max(MIN_LOG_POLL_MS, Math.min(MAX_LOG_POLL_MS, Math.floor(stallTimeoutMs / 4)));
}

function sameSnapshot(
  left: ConnectorLogSnapshot | undefined,
  right: ConnectorLogSnapshot | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.path === right.path && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function safeReadLogSnapshot(
  pathTemplate: string,
  values: ConnectorTemplateValues,
): ConnectorLogSnapshot | undefined {
  try {
    return readConnectorLogSnapshot(pathTemplate, values);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

export async function runConnectorProcess(
  spawn: AppConnector.Spawn,
  logs: AppConnector.Logs | undefined,
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: ConnectorTemplateValues,
  credentialEnv: Record<string, string>,
  questionBridgeHandler: ConnectorQuestionBridgeHandler | undefined,
  residentSessionId: string,
): Promise<ConnectorProcessResult> {
  const timeoutMs = spawn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bridge = questionBridgeEnabled(questionBridge)
    ? startConnectorQuestionBridgeServer({
        runId: values.runId,
        sessionId: values.sessionId,
        residentSessionId,
        handler: questionBridgeHandler,
      })
    : undefined;
  const renderedQuestionBridge = effectiveQuestionBridge(questionBridge, bridge !== undefined);

  try {
    const proc = Bun.spawn(
      [renderConnectorTemplate(spawn.command, values), ...renderConnectorArgs(spawn, values)],
      {
        cwd: renderConnectorCwd(spawn, values),
        detached: true,
        env: renderConnectorEnv(spawn, renderedQuestionBridge, values, credentialEnv, bridge?.env),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let interruptionReason: "timeout" | "stall_timeout" | undefined;
    const interrupt = (reason: "timeout" | "stall_timeout") => {
      if (interruptionReason !== undefined) return;
      interruptionReason = reason;
      terminateProcess(proc);
    };
    const timeoutTimer = setTimeout(() => interrupt("timeout"), timeoutMs);
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let logPollTimer: ReturnType<typeof setInterval> | undefined;
    const resetStallTimer = () => {
      if (spawn.stallTimeoutMs === undefined) return;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => interrupt("stall_timeout"), spawn.stallTimeoutMs);
    };
    const startLogActivityPolling = () => {
      if (
        spawn.stallTimeoutMs === undefined ||
        logs === undefined ||
        logs.path === "stdout" ||
        logs.path === "stderr"
      ) {
        return;
      }
      let previous = safeReadLogSnapshot(logs.path, values);
      logPollTimer = setInterval(() => {
        const next = safeReadLogSnapshot(logs.path, values);
        if (!sameSnapshot(previous, next)) {
          previous = next;
          resetStallTimer();
        }
      }, logPollIntervalMs(spawn.stallTimeoutMs));
    };

    resetStallTimer();
    startLogActivityPolling();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout, resetStallTimer),
        readStream(proc.stderr, resetStallTimer),
        proc.exited,
      ]);
      if (interruptionReason !== undefined) {
        const reasonTimeoutMs =
          interruptionReason === "stall_timeout" ? (spawn.stallTimeoutMs ?? timeoutMs) : timeoutMs;
        return {
          outcome: {
            status: "interrupted",
            stdout,
            stderr: stderr || interruptionMessage(interruptionReason, reasonTimeoutMs),
            interruptionReason,
          },
          redactions: bridge?.redactions ?? [],
        };
      }
      return {
        outcome: {
          status: exitCode === 0 ? "succeeded" : "failed",
          stdout,
          stderr,
          exitCode,
        },
        redactions: bridge?.redactions ?? [],
      };
    } finally {
      clearTimeout(timeoutTimer);
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      if (logPollTimer !== undefined) clearInterval(logPollTimer);
    }
  } catch (error) {
    if (error instanceof Error) {
      return {
        outcome: {
          status: "failed",
          stdout: "",
          stderr: "",
          error: error.message,
        },
        redactions: bridge?.redactions ?? [],
      };
    }
    throw error;
  } finally {
    bridge?.close();
  }
}
