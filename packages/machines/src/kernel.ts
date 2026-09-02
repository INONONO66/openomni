// allow: SIZE_OK — one serial host-frame state machine keeps process generation,
// deadline, and tool settlement atomic.
import { Machine } from "@openomni/protocol";
import type { ChildProcessWithoutNullStreams } from "./launcher";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const OUTPUT_LIMIT_ERROR = "cell output exceeded maxOutputBytes";

export { PYTHON_DRIVER } from "./python-driver";

type ToolCallFrame = {
  readonly callId: string;
  readonly cellId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

/**
 * Frames the driver writes back: either a `tool.<name>()` call to service, or
 * the cell's own result. Internal to this stdin/stdout channel — the host
 * boundary speaks `Machine.ToolCall` / `Machine.CellResult` instead.
 */
function isToolCallFrame(frame: unknown): frame is ToolCallFrame {
  return (frame as { kind?: unknown } | null)?.kind === "tool_call";
}

function isOutputLimitFrame(frame: unknown): boolean {
  return (frame as { kind?: unknown } | null)?.kind === "output_limit";
}

function resultOf(frame: unknown): unknown {
  return (frame as { result?: unknown } | null)?.result;
}

/** Answers a `tool.<name>()` call made from inside a cell. */
export type CellToolCaller = (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;

type PendingCell = {
  readonly resolve: (result: Machine.CellResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cellId: string;
  readonly callTool: CellToolCaller;
  readonly inFlight: Map<string, Promise<void>>;
  /**
   * The interpreter this cell was written to. A replaced interpreter dies
   * asynchronously, so its exit must never settle a cell already handed to
   * its successor.
   */
  readonly process: ChildProcessWithoutNullStreams;
};

/** One serial, persistent Python interpreter owned by a daemon attachment. */
export class PythonKernel {
  private process: ChildProcessWithoutNullStreams | undefined;
  private pending: PendingCell | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly maxOutputBytes: number;

  constructor(
    private readonly options: {
      readonly launch: () => ChildProcessWithoutNullStreams;
      readonly maxOutputBytes?: number;
    },
  ) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  run(request: Machine.CellRequest, callTool: CellToolCaller): Promise<Machine.CellResult> {
    const deadline = Date.now() + request.timeoutMs;
    let queueExpired = false;
    let resolveResult!: (result: Machine.CellResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<Machine.CellResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const queueTimer = setTimeout(() => {
      queueExpired = true;
      resolveResult({ status: "timed_out", cellId: request.cellId });
    }, request.timeoutMs);

    const operation = this.tail.then(() => {
      clearTimeout(queueTimer);
      if (queueExpired) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        queueExpired = true;
        resolveResult({ status: "timed_out", cellId: request.cellId });
        return;
      }
      return this.execute(request, callTool, remainingMs).then(resolveResult, rejectResult);
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    const process = this.process;
    this.process = undefined;
    process?.kill("SIGKILL");
  }

  private execute(
    request: Machine.CellRequest,
    callTool: CellToolCaller,
    timeoutMs: number,
  ): Promise<Machine.CellResult> {
    const process = this.process ?? this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingFor(process);
        this.pending = undefined;
        pending?.inFlight.clear();
        // Python cannot safely interrupt arbitrary extension/native code. Kill
        // and replace the interpreter instead: state is lost after a timeout,
        // but the next queued cell is guaranteed a fresh, unwedgeable process.
        this.discard(process);
        resolve({ status: "timed_out", cellId: request.cellId });
      }, timeoutMs);
      this.pending = {
        resolve,
        reject,
        timer,
        process,
        cellId: request.cellId,
        callTool,
        inFlight: new Map(),
      };
      process.stdin.write(
        `${JSON.stringify({ ...request, maxOutputBytes: this.maxOutputBytes })}\n`,
      );
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    const process = this.options.launch();
    this.process = process;
    let bufferedSegments: Buffer[] = [];
    let bufferedBytes = 0;

    const acceptLine = (line: string) => {
      const pending = this.pending;
      if (pending?.process !== process) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch (error) {
        this.settleWithParseFailure(process, pending, error);
        return;
      }
      // A tool call leaves the cell pending — including its deadline, so a cell
      // that hangs waiting on a tool still times out honestly.
      if (isToolCallFrame(frame)) {
        this.answerToolCall(process, pending, frame);
        return;
      }
      if (isOutputLimitFrame(frame)) {
        this.settleWithOutputLimit(process, pending);
        return;
      }
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.inFlight.clear();
      try {
        pending.resolve(Machine.CellResult.parse(resultOf(frame)));
      } catch (error) {
        this.discard(process);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    process.stdout.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (bufferedBytes + segment.length > this.maxOutputBytes) {
          bufferedSegments = [];
          bufferedBytes = 0;
          const pending = this.pendingFor(process);
          if (pending !== undefined) {
            this.settleWithOutputLimit(process, pending);
          } else {
            this.discard(process);
          }
          return;
        }
        bufferedSegments.push(segment);
        bufferedBytes += segment.length;
        if (newline === -1) return;
        const line = Buffer.concat(bufferedSegments, bufferedBytes).toString("utf8");
        bufferedSegments = [];
        bufferedBytes = 0;
        acceptLine(line);
        offset = newline + 1;
      }
    });

    const fail = (error: Error) => {
      if (this.process === process) {
        this.process = undefined;
      }
      const pending = this.pending;
      if (pending?.process !== process) return;
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.inFlight.clear();
      pending.reject(error);
    };
    process.once("error", fail);
    process.once("exit", (code, signal) => {
      fail(new Error(`python3 exited before replying (code=${String(code)}, signal=${signal})`));
    });
    return process;
  }

  private settleWithParseFailure(
    process: ChildProcessWithoutNullStreams,
    pending: PendingCell,
    error: unknown,
  ): void {
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.inFlight.clear();
    this.discard(process);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private settleWithOutputLimit(
    process: ChildProcessWithoutNullStreams,
    pending: PendingCell,
  ): void {
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.inFlight.clear();
    this.discard(process);
    pending.resolve({
      status: "raised",
      cellId: pending.cellId,
      output: { stdout: "", stderr: "" },
      error: OUTPUT_LIMIT_ERROR,
    });
  }

  private answerToolCall(
    process: ChildProcessWithoutNullStreams,
    pending: PendingCell,
    frame: ToolCallFrame,
  ): void {
    // The driver stamps every tool call with the cell it belongs to. A frame
    // claiming a different cell — forged from inside cell code via the raw
    // stdout, or from a driver bug — must never execute under the running
    // cell's identity; it is answered with a refusal instead.
    if (frame.cellId !== pending.cellId) {
      try {
        process.stdin.write(
          `${JSON.stringify({
            status: "failed",
            error: `tool call refused: cell ${String(frame.cellId)} is not the running cell`,
            callId: frame.callId,
          })}\n`,
        );
      } catch (error) {
        this.settleWithParseFailure(process, pending, error);
      }
      return;
    }
    // Duplicate or late frames have no waiter and must not create another host call.
    if (pending.inFlight.has(frame.callId)) return;

    const task = Promise.resolve()
      .then(() =>
        pending.callTool({ cellId: pending.cellId, name: frame.name, arguments: frame.arguments }),
      )
      .catch(
        (error: unknown): Machine.ToolCallResult => ({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((answer) => {
        // The cell may already have timed out and taken its interpreter with
        // it; a callId removed from this cell's map no longer owns an answer.
        if (this.pending !== pending || !pending.inFlight.has(frame.callId)) return;
        process.stdin.write(`${JSON.stringify({ ...answer, callId: frame.callId })}\n`);
      })
      .catch((error: unknown) => {
        // A synchronous serialization/write failure is a kernel-channel failure,
        // but a stale process has already been deliberately discarded.
        if (this.pending === pending && pending.inFlight.has(frame.callId)) {
          this.settleWithParseFailure(process, pending, error);
        }
      });
    pending.inFlight.set(frame.callId, task);
    void task.finally(() => {
      if (pending.inFlight.get(frame.callId) === task) {
        pending.inFlight.delete(frame.callId);
      }
    });
  }

  private pendingFor(process: ChildProcessWithoutNullStreams): PendingCell | undefined {
    return this.pending?.process === process ? this.pending : undefined;
  }

  private discard(process: ChildProcessWithoutNullStreams): void {
    if (this.process === process) {
      this.process = undefined;
    }
    process.kill("SIGKILL");
  }
}
