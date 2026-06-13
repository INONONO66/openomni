import type { AppConnector } from "@openomni/protocol";
import {
  type LocalCliTemplateValues,
  renderLocalCliArgs,
  renderLocalCliCwd,
  renderLocalCliEnv,
  renderLocalCliTemplate,
} from "./local-cli-agent-env.js";
import {
  startLocalCliQuestionBridgeServer,
  type LocalCliQuestionBridgeHandler,
} from "./local-cli-question-bridge.js";

export interface LocalCliAgentProcessOutcome {
  readonly status: "succeeded" | "failed" | "interrupted";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly interruptionReason?: "timeout" | "stall_timeout";
}

export interface LocalCliAgentProcessResult {
  readonly outcome: LocalCliAgentProcessOutcome;
  readonly redactions: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 600_000;

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
    return `local CLI process stalled after ${timeoutMs}ms without output`;
  }
  return `local CLI process timed out after ${timeoutMs}ms`;
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

export async function runLocalCliAgentProcess(
  spawn: AppConnector.Spawn,
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: LocalCliTemplateValues,
  credentialEnv: Record<string, string>,
  questionBridgeHandler: LocalCliQuestionBridgeHandler | undefined,
  residentSessionId: string,
): Promise<LocalCliAgentProcessResult> {
  const timeoutMs = spawn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bridge = questionBridgeEnabled(questionBridge)
    ? startLocalCliQuestionBridgeServer({
        runId: values.runId,
        sessionId: values.sessionId,
        residentSessionId,
        handler: questionBridgeHandler,
      })
    : undefined;
  const renderedQuestionBridge = effectiveQuestionBridge(questionBridge, bridge !== undefined);

  try {
    const proc = Bun.spawn(
      [renderLocalCliTemplate(spawn.command, values), ...renderLocalCliArgs(spawn, values)],
      {
        cwd: renderLocalCliCwd(spawn, values),
        detached: true,
        env: renderLocalCliEnv(spawn, renderedQuestionBridge, values, credentialEnv, bridge?.env),
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
    const resetStallTimer = () => {
      if (spawn.stallTimeoutMs === undefined) return;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => interrupt("stall_timeout"), spawn.stallTimeoutMs);
    };

    resetStallTimer();
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
