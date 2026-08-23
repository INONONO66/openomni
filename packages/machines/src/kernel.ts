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

_scope = {"__name__": "__main__"}
for _line in sys.stdin:
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
    except BaseException:
        _result = {
            "status": "raised",
            "cellId": _request["cellId"],
            "output": {"stdout": _stdout.getvalue(), "stderr": _stderr.getvalue()},
            "error": traceback.format_exc(),
        }
    sys.__stdout__.write(json.dumps(_result) + "\n")
    sys.__stdout__.flush()
`;

type PendingCell = {
  readonly resolve: (result: Machine.CellResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
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

  run(request: Machine.CellRequest): Promise<Machine.CellResult> {
    const result = this.tail.then(() => this.execute(request));
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

  private execute(request: Machine.CellRequest): Promise<Machine.CellResult> {
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
      this.pending = { resolve, reject, timer, process };
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
      clearTimeout(pending.timer);
      this.pending = undefined;
      try {
        pending.resolve(Machine.CellResult.parse(JSON.parse(line)));
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

  private discard(process: ChildProcessWithoutNullStreams): void {
    if (this.process === process) {
      this.process = undefined;
      this.lines?.close();
      this.lines = undefined;
    }
    process.kill("SIGKILL");
  }
}
