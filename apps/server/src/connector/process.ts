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
// #517 termination contract: group SIGTERM → bounded graceful window → group
// SIGKILL → bounded reap. Dispatch settles when the group is gone or the reap
// window closes — never "whenever a TERM-resistant descendant releases the
// inherited pipes".
const GRACEFUL_TERMINATION_WINDOW_MS = 2_000;
const KILL_REAP_WINDOW_MS = 2_000;
const GROUP_POLL_MS = 25;
const INTERRUPT_DRAIN_MS = 150;

type GroupTerminationResult = "already_exited" | "terminated" | "killed" | "unreaped";

type SpawnedProcess = {
  readonly pid: number;
  kill(signal?: number | NodeJS.Signals): void;
};

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH means the group is gone — EPERM is "alive but
    // unsignalable" (e.g. a uid-changing descendant), and reporting that as
    // exited would skip the kill flow entirely.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(proc: SpawnedProcess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-proc.pid, signal);
    return;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  try {
    proc.kill(signal);
  } catch {
    // Parent already reaped; descendants (if any) are covered by the group
    // probe loop in terminateProcessGroup.
  }
}

async function waitForGroupExit(pid: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await Bun.sleep(GROUP_POLL_MS);
  }
  return !groupAlive(pid);
}

/**
 * #517 — one termination flow, memoized by the caller across every
 * interruption path. Probes group liveness before each signal so an observed
 * group exit is never signalled again.
 */
async function terminateProcessGroup(proc: SpawnedProcess): Promise<GroupTerminationResult> {
  if (!groupAlive(proc.pid)) return "already_exited";
  signalGroup(proc, "SIGTERM");
  if (await waitForGroupExit(proc.pid, GRACEFUL_TERMINATION_WINDOW_MS)) return "terminated";
  if (!groupAlive(proc.pid)) return "terminated";
  signalGroup(proc, "SIGKILL");
  return (await waitForGroupExit(proc.pid, KILL_REAP_WINDOW_MS)) ? "killed" : "unreaped";
}

function interruptionMessage(reason: "timeout" | "stall_timeout", timeoutMs: number): string {
  if (reason === "stall_timeout") {
    return `connector process stalled after ${timeoutMs}ms without output`;
  }
  return `connector process timed out after ${timeoutMs}ms`;
}

/**
 * Cancellable stream drain. `cancel()` is the #517 backstop for a descendant
 * that survives even the group SIGKILL while holding an inherited pipe: the
 * read resolves with whatever arrived instead of keeping the dispatch
 * pending forever.
 */
function readStreamCancellable(
  stream: ReadableStream<Uint8Array> | null,
  onActivity: () => void,
): { readonly output: Promise<string>; cancel(): void } {
  if (stream === null) {
    return { output: Promise.resolve(""), cancel: () => undefined };
  }
  const reader = stream.getReader();
  let cancelled = false;
  const output = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.length > 0) onActivity();
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch (error) {
      // cancel() resolves the pending read with done, it does not throw —
      // an error here is a REAL stream failure. After cancellation return
      // the partial output; otherwise keep the pre-#517 semantics (the
      // rejection reaches the outer catch and the run reports failed).
      if (!cancelled) throw error;
    } finally {
      reader.releaseLock();
    }
    return text + decoder.decode();
  })();
  return {
    output,
    cancel: () => {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    },
  };
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
  traceId: string,
): Promise<ConnectorProcessResult> {
  const timeoutMs = spawn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bridge = questionBridgeEnabled(questionBridge)
    ? startConnectorQuestionBridgeServer({
        traceId,
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
    let termination: Promise<GroupTerminationResult> | undefined;
    const terminate = () => {
      termination ??= terminateProcessGroup(proc);
      return termination;
    };
    let signalInterrupted!: () => void;
    const interrupted = new Promise<void>((resolveInterrupted) => {
      signalInterrupted = resolveInterrupted;
    });
    const interrupt = (reason: "timeout" | "stall_timeout") => {
      // First interruption reason wins under concurrent signals; the
      // termination flow itself is memoized so repeated triggers cannot
      // duplicate cleanup.
      if (interruptionReason !== undefined) return;
      interruptionReason = reason;
      signalInterrupted();
      void terminate();
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
    const stdoutRead = readStreamCancellable(proc.stdout, resetStallTimer);
    const stderrRead = readStreamCancellable(proc.stderr, resetStallTimer);
    try {
      type SettledRun = {
        stdout: string;
        stderr: string;
        exitCode?: number;
        reaping?: GroupTerminationResult;
      };
      const naturalSettle = Promise.all([stdoutRead.output, stderrRead.output, proc.exited]).then(
        ([stdout, stderr, exitCode]): SettledRun => ({
          stdout,
          stderr,
          exitCode,
        }),
      );
      // #517: an interrupted run settles when the process GROUP is gone (or
      // the bounded reap window closes) — never "when a TERM-resistant
      // descendant lets go of the inherited pipes". After termination the
      // streams get a short drain window, then the readers are cancelled so
      // the dispatch can always settle with partial output.
      const boundedInterruptSettle = interrupted.then(async (): Promise<SettledRun> => {
        const reaping = await terminate();
        await Promise.race([
          Promise.all([stdoutRead.output, stderrRead.output]),
          Bun.sleep(INTERRUPT_DRAIN_MS),
        ]);
        stdoutRead.cancel();
        stderrRead.cancel();
        const [stdout, stderr] = await Promise.all([stdoutRead.output, stderrRead.output]);
        return { stdout, stderr, reaping };
      });
      const settled = await Promise.race([naturalSettle, boundedInterruptSettle]);
      // Read synchronously after the race: a timer cannot interleave here, so
      // a natural exit at the deadline classifies deterministically by
      // whether its interruption fired before the settle.
      const reason = interruptionReason;
      if (reason !== undefined) {
        const reasonTimeoutMs =
          reason === "stall_timeout" ? (spawn.stallTimeoutMs ?? timeoutMs) : timeoutMs;
        const unreaped =
          settled.reaping === "unreaped"
            ? "; process group could not be reaped within the bounded window"
            : "";
        return {
          outcome: {
            status: "interrupted",
            stdout: settled.stdout,
            stderr: settled.stderr || `${interruptionMessage(reason, reasonTimeoutMs)}${unreaped}`,
            interruptionReason: reason,
          },
          redactions: bridge?.redactions ?? [],
        };
      }
      return {
        outcome: {
          status: settled.exitCode === 0 ? "succeeded" : "failed",
          stdout: settled.stdout,
          stderr: settled.stderr,
          exitCode: settled.exitCode,
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
