import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { Machine } from "@openomni/protocol";
import type { MachineError } from "@openomni/machines";
import { Cause, Deferred, Effect, Exit, Queue, type Scope } from "effect";
import { DriverFailure, type CodeError } from "./errors";
import { decodeCodeFailure } from "./failure";
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


class _Output(io.TextIOBase):
    """A cell stream: buffered for the result frame, streamed so a peek sees it live."""

    def __init__(self, cell_id, stream):
        self._cell_id = cell_id
        self._stream = stream
        self._buffer = io.StringIO()

    def writable(self):
        return True

    def write(self, text):
        if text:
            self._buffer.write(text)
            _emit({"kind": "output", "cellId": self._cell_id, "stream": self._stream, "text": text})
        return len(text)

    def getvalue(self):
        return self._buffer.getvalue()


def completion(prompt, model=None, system=None, schema=None):
    """One stateless sub-model call; with a JSON Schema the answer is decoded JSON."""
    _arguments = {"prompt": prompt}
    if model is not None:
        _arguments["model"] = model
    if system is not None:
        _arguments["system"] = system
    if schema is not None:
        _arguments["schema"] = schema
    _answer = tool.completion(**_arguments)
    return json.loads(_answer) if schema is not None else _answer


class _Machine:
    def __init__(self, machine_id):
        self.machine_id = machine_id

    def read(self, path):
        value = tool['codemode.read'](machineId=self.machine_id, path=path)
        value['data'] = base64.b64decode(value['data'])
        return value

    def write(self, path, data):
        return tool['codemode.write'](machineId=self.machine_id, path=path, data=base64.b64encode(data).decode('ascii'))

    def ls(self, path):
        return tool['codemode.ls'](machineId=self.machine_id, path=path)

    def bash(self, command, cwd):
        value = tool['codemode.bash'](machineId=self.machine_id, cmd=command, cwd=cwd)
        if value['status'] == 'completed':
            value['stdout'] = base64.b64decode(value['stdout'])
            value['stderr'] = base64.b64decode(value['stderr'])
        return value

    def eval(self, code):
        return tool['codemode.eval'](machineId=self.machine_id, code=code)


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
    "completion": completion,
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
    _stdout = _Output(_request["cellId"], "stdout")
    _stderr = _Output(_request["cellId"], "stderr")
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
const OutputFrame = z
  .object({
    kind: z.literal("output"),
    cellId: z.string().min(1),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  })
  .strict();
const Frame = z.discriminatedUnion("kind", [
  ToolCallFrame,
  OutputFrame,
  z.object({ kind: z.literal("result"), result: Machine.CellResult }).strict(),
]);

/** Answers a call made from inside a cell. */
type CellToolCaller = (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, MachineError>;
type PendingCell = {
  readonly cellId: string;
  readonly process: ChildProcessWithoutNullStreams;
  readonly frames: Queue.Queue<string | DriverFailure>;
  readonly output: { stdout: string; stderr: string };
  readonly inFlight: Set<string>;
};

/** A serial interpreter; fibers belong to each invocation, not a package runtime. */
export class PythonKernel {
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private pending: PendingCell | undefined;
  private readonly lock = Effect.unsafeMakeSemaphore(1);
  private readonly lifetime = new AbortController();
  private readonly exits = new Set<Deferred.Deferred<void>>();
  private readonly processExits = new WeakMap<ChildProcessWithoutNullStreams, Deferred.Deferred<void>>();

  run(request: Machine.CellRequest, callTool: CellToolCaller, signal?: AbortSignal): Effect.Effect<Machine.CellResult, CodeError> {
    return Effect.suspend(() => {
      const cancellation = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      const output = { stdout: "", stderr: "" };
      const cancelled = (): Machine.CellResult => ({ status: "cancelled", cellId: request.cellId, output: { ...output } });
      if (cancellation.aborted) return Effect.succeed(cancelled());
      const abort = Effect.async<Machine.CellResult>((resume) => {
        const listener = () => resume(Effect.sync(cancelled));
        cancellation.addEventListener("abort", listener, { once: true });
        if (cancellation.aborted) listener();
        return Effect.sync(() => cancellation.removeEventListener("abort", listener));
      });
      return this.lock.withPermits(1)(this.execute(request, callTool, output)).pipe(
        Effect.raceFirst(abort),
        Effect.timeoutOption(request.timeoutMs),
        Effect.map((result): Machine.CellResult => result._tag === "Some" ? result.value : { status: "timed_out", cellId: request.cellId, output: { ...output } }),
      );
    });
  }

  peek(cellId: string): Machine.CellOutput | undefined {
    return this.pending?.cellId === cellId ? { ...this.pending.output } : undefined;
  }

  close(): Effect.Effect<void, CodeError> {
    return Effect.gen(this, function* () {
      this.lifetime.abort();
      if (this.process) yield* this.discard(this.process);
      yield* Effect.forEach([...this.exits], Deferred.await, { discard: true });
    });
  }

  private execute(request: Machine.CellRequest, callTool: CellToolCaller, output: PendingCell["output"]): Effect.Effect<Machine.CellResult, CodeError> {
    return Effect.scoped(Effect.gen(this, function* () {
      const process = this.process ?? (yield* this.start());
      const frames = yield* Queue.unbounded<string | DriverFailure>();
      const pending: PendingCell = { cellId: request.cellId, process, frames, output, inFlight: new Set() };
      this.pending = pending;
      return yield* Effect.gen(this, function* () {
        yield* this.write(process, request);
        for (;;) {
          const line = yield* Queue.take(frames);
          if (line instanceof DriverFailure) return yield* line;
          const frame = yield* Effect.try({ try: () => Frame.parse(JSON.parse(line)), catch: decodeCodeFailure("driver.frame") }).pipe(
            Effect.mapError((error) => new DriverFailure({ operation: "driver.frame", message: "invalid driver frame", cause: String(error) })),
          );
          if (frame.kind === "tool_call") {
            yield* this.answerToolCall(pending, frame, callTool);
          } else if (frame.kind === "output") {
            if (frame.cellId === pending.cellId) pending.output[frame.stream] += frame.text;
          } else {
            this.pending = undefined;
            return frame.result;
          }
        }
      }).pipe(Effect.ensuring(Effect.gen(this, function* () {
        if (this.pending === pending) {
          this.pending = undefined;
          yield* Effect.orDie(this.discard(process));
        }
        pending.inFlight.clear();
        yield* Queue.shutdown(frames);
      })));
    }));
  }

  private answerToolCall(pending: PendingCell, frame: ToolCallFrame, callTool: CellToolCaller): Effect.Effect<void, CodeError, Scope.Scope> {
    return Effect.gen(this, function* () {
      if (frame.cellId !== pending.cellId) {
        return yield* this.write(pending.process, { status: "failed", error: `tool call refused: cell ${frame.cellId} is not the running cell`, callId: frame.callId });
      }
      if (pending.inFlight.has(frame.callId)) return;
      pending.inFlight.add(frame.callId);
      yield* Effect.forkScoped(Effect.suspend(() => callTool({ cellId: pending.cellId, name: frame.name, arguments: frame.arguments })).pipe(
        Effect.catchAllCause((cause) => Effect.succeed({ status: "failed", error: Cause.pretty(cause) } as const)),
        Effect.flatMap((answer) => this.pending === pending ? this.write(pending.process, { ...answer, callId: frame.callId }) : Effect.void),
        Effect.catchAll((error) => Effect.sync(() => { pending.frames.unsafeOffer(new DriverFailure({ operation: "driver.write", message: "driver write failed", cause: String(error) })); })),
        Effect.ensuring(Effect.sync(() => { pending.inFlight.delete(frame.callId); })),
      ));
    });
  }

  private write(process: ChildProcessWithoutNullStreams, value: Machine.CellRequest | (Machine.ToolCallResult & { callId: string })): Effect.Effect<void, CodeError> {
    return Effect.try({ try: () => { process.stdin.write(`${JSON.stringify(value)}\n`); }, catch: decodeCodeFailure("driver.write") });
  }

  private start(): Effect.Effect<ChildProcessWithoutNullStreams, CodeError> {
    return Effect.gen(this, function* () {
      const exited = yield* Deferred.make<void>();
      const process = yield* Effect.try({ try: () => spawn("python3", ["-u", "-c", PYTHON_DRIVER]), catch: decodeCodeFailure("driver.spawn") });
      this.exits.add(exited);
      this.processExits.set(process, exited);
      process.once("close", () => { this.exits.delete(exited); Deferred.unsafeDone(exited, Exit.void); });
      const lines = createInterface({ input: process.stdout });
      this.process = process;
      this.lines = lines;
      lines.on("line", (line) => {
        if (this.pending?.process === process) this.pending.frames.unsafeOffer(line);
      });
      const fail = (message: string) => {
        if (this.process === process) { this.process = undefined; this.lines = undefined; }
        if (this.pending?.process === process) this.pending.frames.unsafeOffer(new DriverFailure({ operation: "driver.process", message, cause: message }));
      };
      process.once("error", (error) => fail(error.message));
      process.once("exit", (code, signal) => fail(`python3 exited before replying (code=${String(code)}, signal=${signal})`));
      return process;
    });
  }

  private discard(process: ChildProcessWithoutNullStreams): Effect.Effect<void, CodeError> {
    return Effect.gen(this, function* () {
    const exited = this.processExits.get(process);
    if (exited === undefined) return yield* Effect.die("missing process close witness");
    yield* Effect.try({ try: () => {
      if (this.process === process) { this.process = undefined; this.lines?.close(); this.lines = undefined; }
      process.kill("SIGKILL");
    }, catch: decodeCodeFailure("driver.kill") });
    yield* Deferred.await(exited);
    });
  }
}
