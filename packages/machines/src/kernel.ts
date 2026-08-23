import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { Machine } from "@openomni/protocol";

const PYTHON_DRIVER = String.raw`
import ast
import contextlib
import io
import json
import sys
import traceback

def _emit(payload):
    sys.__stdout__.write(json.dumps(payload) + "\n")
    sys.__stdout__.flush()


class ToolError(Exception):
    """Raised in the cell when a host tool refuses or fails, so it is catchable."""


class _Tools:
    """tool.<name>(**kwargs) and tool["dotted.name"](**kwargs) reach the host."""

    def __getattr__(self, name):
        return self[name]

    def __getitem__(self, name):
        def call(**arguments):
            _emit({"kind": "tool_call", "name": name, "arguments": arguments})
            # The driver blocks here; the host's answer is the next line in.
            _answer = json.loads(sys.__stdin__.readline())
            if _answer["status"] == "completed":
                return _answer["value"]
            raise ToolError(_answer["error"])

        return call


_scope = {"__name__": "__main__", "tool": _Tools(), "ToolError": ToolError}
# readline() rather than iteration: a cell blocked on a tool call reads the
# answer from the same stream, and the iterator's read-ahead would swallow it.
while True:
    _line = sys.__stdin__.readline()
    if not _line:
        break
    _request = json.loads(_line)
    _stdout = io.StringIO()
    _stderr = io.StringIO()
    _filename = f"<cell {_request['cellId']}>"
    try:
        with contextlib.redirect_stdout(_stdout), contextlib.redirect_stderr(_stderr):
            _tree = ast.parse(_request["code"], filename=_filename, mode="exec")
            _value = None
            _has_value = False
            if _tree.body and isinstance(_tree.body[-1], ast.Expr):
                _body = ast.Module(body=_tree.body[:-1], type_ignores=_tree.type_ignores)
                if _body.body:
                    exec(compile(_body, _filename, "exec"), _scope)
                _value = eval(compile(ast.Expression(_tree.body[-1].value), _filename, "eval"), _scope)
                # A trailing expression evaluating to None reports no value, matching
                # the REPL convention that None is not worth echoing.
                _has_value = _value is not None
            else:
                exec(compile(_tree, _filename, "exec"), _scope)
        _result = {
            "status": "completed",
            "cellId": _request["cellId"],
            "output": {"stdout": _stdout.getvalue(), "stderr": _stderr.getvalue()},
        }
        if _has_value:
            _result["value"] = repr(_value)
    except BaseException as _exc:
        # Drop this driver's own exec/eval frame so the reported traceback starts
        # at the caller's code rather than at the harness that ran it.
        _tb = _exc.__traceback__.tb_next if _exc.__traceback__ else None
        _result = {
            "status": "raised",
            "cellId": _request["cellId"],
            "output": {"stdout": _stdout.getvalue(), "stderr": _stderr.getvalue()},
            "error": "".join(traceback.format_exception(type(_exc), _exc, _tb)),
        }
    _emit({"kind": "result", "result": _result})
`;

type ToolCallFrame = { readonly name: string; readonly arguments: Record<string, unknown> };

/**
 * Frames the driver writes back: either a `tool.<name>()` call to service, or
 * the cell's own result. Internal to this stdin/stdout channel — the host
 * boundary speaks `Machine.ToolCall` / `Machine.CellResult` instead.
 */
function isToolCallFrame(frame: unknown): frame is ToolCallFrame {
  return (frame as { kind?: unknown } | null)?.kind === "tool_call";
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
  private lines: Interface | undefined;
  private pending: PendingCell | undefined;
  private tail: Promise<void> = Promise.resolve();

  run(request: Machine.CellRequest, callTool: CellToolCaller): Promise<Machine.CellResult> {
    const result = this.tail.then(() => this.execute(request, callTool));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    const process = this.process;
    this.process = undefined;
    this.lines?.close();
    this.lines = undefined;
    process?.kill("SIGKILL");
  }

  private execute(
    request: Machine.CellRequest,
    callTool: CellToolCaller,
  ): Promise<Machine.CellResult> {
    const process = this.process ?? this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        // Python cannot safely interrupt arbitrary extension/native code. Kill
        // and replace the interpreter instead: state is lost after a timeout,
        // but the next queued cell is guaranteed a fresh, unwedgeable process.
        this.discard(process);
        resolve({ status: "timed_out", cellId: request.cellId });
      }, request.timeoutMs);
      this.pending = { resolve, reject, timer, process, cellId: request.cellId, callTool };
      process.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    const process = spawn("python3", ["-u", "-c", PYTHON_DRIVER]);
    const lines = createInterface({ input: process.stdout });
    this.process = process;
    this.lines = lines;

    lines.on("line", (line) => {
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
      clearTimeout(pending.timer);
      this.pending = undefined;
      try {
        pending.resolve(Machine.CellResult.parse(resultOf(frame)));
      } catch (error) {
        this.discard(process);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const fail = (error: Error) => {
      if (this.process === process) {
        this.process = undefined;
        this.lines = undefined;
      }
      const pending = this.pending;
      if (pending?.process !== process) return;
      clearTimeout(pending.timer);
      this.pending = undefined;
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
    this.discard(process);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private answerToolCall(
    process: ChildProcessWithoutNullStreams,
    pending: PendingCell,
    frame: ToolCallFrame,
  ): void {
    pending
      .callTool({ cellId: pending.cellId, name: frame.name, arguments: frame.arguments })
      .catch(
        (error: unknown): Machine.ToolCallResult => ({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((answer) => {
        // The cell may already have timed out and taken its interpreter with
        // it; writing to the replaced process would resume a dead cell.
        if (this.pending !== pending) return;
        process.stdin.write(`${JSON.stringify(answer)}\n`);
      });
  }

  private discard(process: ChildProcessWithoutNullStreams): void {
    if (this.process === process) {
      this.process = undefined;
      this.lines?.close();
      this.lines = undefined;
    }
    process.kill("SIGKILL");
  }
}
