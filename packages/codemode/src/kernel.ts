import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { Machine } from "@openomni/protocol";
import { z } from "zod";

const PYTHON_DRIVER = String.raw`
import ast
import base64
import concurrent.futures
import contextlib
import io
import itertools
import json
import queue
import sys
import threading
import traceback

_emit_lock = threading.Lock()
_cell_context = threading.local()
_cell_requests = queue.Queue()
_answer_queues = {}
_answer_queues_lock = threading.Lock()
_call_ids = itertools.count(1)


def _emit(payload):
    with _emit_lock:
        sys.__stdout__.write(json.dumps(payload) + "\n")
        sys.__stdout__.flush()


def _read_stdin():
    while True:
        _line = sys.__stdin__.readline()
        if not _line:
            with _answer_queues_lock:
                _waiting = list(_answer_queues.values())
                _answer_queues.clear()
            for _answers in _waiting:
                _answers.put({"status": "failed", "error": "driver stdin closed"})
            _cell_requests.put(None)
            return
        _frame = json.loads(_line)
        _call_id = _frame.get("callId")
        if _call_id is None:
            _cell_requests.put(_frame)
            continue
        with _answer_queues_lock:
            _answers = _answer_queues.get(_call_id)
        # A late answer for a timed-out/completed call is intentionally inert.
        if _answers is not None:
            _answers.put(_frame)


class ToolError(Exception):
    """Raised in the cell when a host tool refuses or fails, so it is catchable."""


class _Tools:
    """tool.<name>(**kwargs) and tool["dotted.name"](**kwargs) reach the host."""

    def __getattr__(self, name):
        return self[name]

    def __getitem__(self, name):
        def call(**arguments):
            # The calling thread's cell identity travels with the frame. A bare
            # thread that outlives its cell has no identity and is refused —
            # otherwise it would execute under whichever cell runs next.
            _cell = getattr(_cell_context, "cell_id", None)
            if _cell is None:
                raise ToolError(
                    "tool call refused: tools are reachable only from the cell's"
                    " own execution or its parallel() workers, never from a"
                    " thread that outlives its cell"
                )
            _call_id = str(next(_call_ids))
            _answers = queue.Queue(maxsize=1)
            with _answer_queues_lock:
                _answer_queues[_call_id] = _answers
            try:
                _emit({
                    "kind": "tool_call",
                    "callId": _call_id,
                    "cellId": _cell,
                    "name": name,
                    "arguments": arguments,
                })
                _answer = _answers.get()
            finally:
                with _answer_queues_lock:
                    if _answer_queues.get(_call_id) is _answers:
                        del _answer_queues[_call_id]
            if _answer["status"] == "completed":
                return _answer.get("value")
            raise ToolError(_answer["error"])

        return call


def parallel(thunks, max_workers=8):
    """Run zero-argument callables concurrently and preserve input order."""
    _thunks = list(thunks)
    if not _thunks:
        return []
    _cell = getattr(_cell_context, "cell_id", None)

    def _in_cell(_thunk):
        def _run():
            _cell_context.cell_id = _cell
            return _thunk()

        return _run

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as _executor:
        _futures = [_executor.submit(_in_cell(_thunk)) for _thunk in _thunks]
        concurrent.futures.wait(_futures)
        return [_future.result() for _future in _futures]


def llm(prompts):
    return tool.llm(prompts=prompts)


class _Machine:
    def __init__(self, machine_id):
        self.machine_id = machine_id

    def read(self, path):
        value = tool['codemode.read'](machineId=self.machine_id, path=path)
        value['data'] = base64.b64decode(value['data'])
        return value

    def write(self, path, data):
        return tool['codemode.write'](machineId=self.machine_id, path=path, data=base64.b64encode(data).decode('ascii'))

    def list(self, path):
        return tool['codemode.list'](machineId=self.machine_id, path=path)

    def stat(self, path):
        return tool['codemode.stat'](machineId=self.machine_id, path=path)

    def shell(self, cmd, cwd):
        value = tool['codemode.shell'](machineId=self.machine_id, cmd=cmd, cwd=cwd)
        if value['status'] == 'completed':
            value['stdout'] = base64.b64decode(value['stdout'])
            value['stderr'] = base64.b64decode(value['stderr'])
        return value

    def run(self, code):
        return tool['codemode.run'](machineId=self.machine_id, code=code)


class _Codemode:
    def listMachines(self):
        return tool['codemode.listMachines']()

    def getMachine(self, machine_id):
        return _Machine(machine_id)

    def findMachine(self, query):
        return _Machine(tool['codemode.findMachine'](query=query))


tool = _Tools()
_scope = {
    "__name__": "__main__",
    "tool": tool,
    "ToolError": ToolError,
    "parallel": parallel,
    "llm": llm,
    "codemode": _Codemode(),
}
threading.Thread(target=_read_stdin, name="driver-stdin", daemon=True).start()

# One executor loop keeps cells serial while tool calls made by worker threads
# can independently wait for their callId-routed answers.
while True:
    _request = _cell_requests.get()
    if _request is None:
        break
    _cell_context.cell_id = _request["cellId"]
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
    _cell_context.cell_id = None
    _emit({"kind": "result", "result": _result})
`;

const ToolCallFrame = Machine.ToolCall.extend({
  kind: z.literal("tool_call"),
  callId: z.string().min(1),
});
type ToolCallFrame = z.infer<typeof ToolCallFrame>;
const Frame = z.discriminatedUnion("kind", [
  ToolCallFrame,
  z.object({ kind: z.literal("result"), result: Machine.CellResult }).strict(),
]);

/** Answers a call made from inside a cell. */
type CellToolCaller = (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;

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
  private lines: Interface | undefined;
  private pending: PendingCell | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private readonly exits = new Set<Promise<void>>();

  run(
    request: Machine.CellRequest,
    callTool: CellToolCaller,
    signal?: AbortSignal,
  ): Promise<Machine.CellResult> {
    const cancellation =
      signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
    if (cancellation.aborted)
      return Promise.resolve({ status: "cancelled", cellId: request.cellId });
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

    const abort = () => {
      queueExpired = true;
      clearTimeout(queueTimer);
      const pending = this.pending;
      if (pending?.cellId === request.cellId) {
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.inFlight.clear();
        this.discard(pending.process);
        pending.resolve({ status: "cancelled", cellId: request.cellId });
      }
      resolveResult({ status: "cancelled", cellId: request.cellId });
    };
    cancellation.addEventListener("abort", abort, { once: true });
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
    return result.finally(() => cancellation.removeEventListener("abort", abort));
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    if (this.process !== undefined) this.discard(this.process);
    await this.tail;
    await Promise.all([...this.exits]);
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
      process.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    const process = spawn("python3", ["-u", "-c", PYTHON_DRIVER]);
    const exited = new Promise<void>((resolve) => process.once("close", () => resolve()));
    this.exits.add(exited);
    void exited.then(() => this.exits.delete(exited));
    const lines = createInterface({ input: process.stdout });
    this.process = process;
    this.lines = lines;

    lines.on("line", (line) => {
      const pending = this.pending;
      if (pending?.process !== process) return;
      let frame: z.infer<typeof Frame>;
      try {
        frame = Frame.parse(JSON.parse(line));
      } catch (error) {
        this.settleWithParseFailure(
          process,
          pending,
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      // A tool call leaves the cell pending — including its deadline, so a cell
      // that hangs waiting on a tool still times out honestly.
      if (frame.kind === "tool_call") {
        this.answerToolCall(process, pending, frame);
        return;
      }
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.inFlight.clear();
      try {
        pending.resolve(frame.result);
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
    error: Error,
  ): void {
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.inFlight.clear();
    this.discard(process);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
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
        this.settleWithParseFailure(
          process,
          pending,
          error instanceof Error ? error : new Error(String(error)),
        );
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
        (error: Error): Machine.ToolCallResult => ({
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
      .catch((error: Error) => {
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
      this.lines?.close();
      this.lines = undefined;
    }
    process.kill("SIGKILL");
  }
}
