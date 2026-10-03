import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { Machine } from "@openomni/protocol";
import { onAbort, type MachineError } from "@openomni/machines";
import { Cause, Deferred, Effect, Exit, Queue, type Scope, Semaphore } from "effect";
import { DriverFailure, type CodeError } from "./errors";
import { decodeCodeFailure } from "./failure";
import { z } from "zod";

const PYTHON_DRIVER = String.raw`
import ast
import base64
import concurrent.futures
import contextlib
import hashlib
import io
import itertools
import json
import os
import queue
import re
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

    def screen(self, display=None, region=None):
        args = {'machineId': self.machine_id}
        if display is not None:
            args['display'] = display
        if region is not None:
            args['region'] = region
        value = tool['codemode.screen'](**args)
        if value['status'] == 'ok':
            value['png'] = base64.b64decode(value['png'])
            self._capture_id = value['captureId']
        return value

    def input(self, actions, capture_id=None):
        anchor = capture_id if capture_id is not None else getattr(self, '_capture_id', None)
        if anchor is None:
            raise ToolError('input requires a prior screen() capture or an explicit capture_id')
        return tool['codemode.input'](machineId=self.machine_id, captureId=anchor, actions=actions)

    def pty(self, name):
        return _PtySession(self.machine_id, name)

    def ptyList(self):
        return tool['codemode.ptyList'](machineId=self.machine_id)


class _PtySession:
    """Named persistent terminal (#1273); reattach is just pty(name) again."""

    def __init__(self, machine_id, name):
        self.machine_id = machine_id
        self.name = name

    def open(self, cwd):
        return tool['codemode.ptyOpen'](machineId=self.machine_id, name=self.name, cwd=cwd)

    def write(self, data):
        payload = data.encode('utf-8') if isinstance(data, str) else data
        return tool['codemode.ptyWrite'](machineId=self.machine_id, name=self.name, data=base64.b64encode(payload).decode('ascii'))

    def read(self, cursor=None, wait_ms=None):
        args = {'machineId': self.machine_id, 'name': self.name}
        if cursor is not None:
            args['cursor'] = cursor
        if wait_ms is not None:
            args['waitMs'] = wait_ms
        value = tool['codemode.ptyRead'](**args)
        if value['status'] == 'ok':
            value['data'] = base64.b64decode(value['data'])
        return value

    def resize(self, cols, rows):
        return tool['codemode.ptyResize'](machineId=self.machine_id, name=self.name, cols=cols, rows=rows)

    def close(self):
        return tool['codemode.ptyClose'](machineId=self.machine_id, name=self.name)


class _Codemode:
    def listMachines(self):
        return tool['codemode.listMachines']()

    def getMachine(self, machine_id):
        return _Machine(machine_id)

    def findMachine(self, query):
        return _Machine(tool['codemode.findMachine'](query=query))

# --- Browser recipe (#1275): Playwright over CDP; Chromium lives in a pty.session. ---
BROWSER_DEFAULT_CDP_PORT = 9222
_BROWSER_MARK = "[openomni-browser]"
_BROWSER_INSTALL_HINT = "python -m playwright install chromium"
_BROWSER_DEVTOOLS_LINE = "DevTools listening on ws://"
_browser_clients = {}
_browser_playwright = {"instance": None}

_BROWSER_PORT_PROBE = base64.b64encode(
    (
        (
        "import socket\n"
        "_port = %d\n"
        "while _port < %d:\n"
        "    _sock = socket.socket()\n"
        "    try:\n"
        "        _sock.bind((\"127.0.0.1\", _port))\n"
        "        break\n"
        "    except OSError:\n"
        "        _port += 1\n"
        "    finally:\n"
        "        _sock.close()\n"
        "print(_port)\n"
        )
        % (BROWSER_DEFAULT_CDP_PORT, BROWSER_DEFAULT_CDP_PORT + 100)
    ).encode("ascii")
).decode("ascii")


class BrowserLost(ToolError):
    """Typed browser_lost refusal; terminal_output carries the tmux transcript."""

    def __init__(self, message, terminal_output):
        self.reason = "browser_lost"
        self.terminal_output = terminal_output
        super().__init__(
            "browser_lost: " + message + "\n--- tmux session output ---\n" + terminal_output
        )


def _browser_playwright_instance():
    if _browser_playwright["instance"] is None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as error:
            raise ToolError(
                "browser() needs the playwright package in this interpreter: "
                "pip install playwright && " + _BROWSER_INSTALL_HINT
            ) from error
        _browser_playwright["instance"] = sync_playwright().start()
    return _browser_playwright["instance"]


def _shell_quote(value):
    return "'" + value.replace("'", "'\\''") + "'"


class BrowserClient:
    """Thin handle over playwright.chromium.connect_over_cdp (#1275): browser,
    context(s) and pages are the raw Playwright objects; the only added
    behavior is liveness translation into the typed BrowserLost refusal."""

    def __init__(self, machine_id, profile_dir, headless):
        self.machine_id = machine_id
        self.profile_dir = profile_dir
        self.headless = headless
        self.session = (
            "openomni-browser-" + hashlib.sha256(profile_dir.encode("utf-8")).hexdigest()[:12]
        )
        self.port = None
        self.endpoint = None
        self._cursor = None
        self._transcript = ""
        self._browser = None

    def _pty(self):
        return _Machine(self.machine_id).pty(self.session)

    def _drain(self, wait_ms=None):
        """Pull terminal output onto the retained transcript; None = session gone."""
        try:
            view = self._pty().read(cursor=self._cursor, wait_ms=wait_ms)
        except ToolError:
            return None
        if view.get("status") != "ok":
            return None
        self._cursor = view["cursor"]
        text = view["data"].decode("utf-8", "replace")
        self._transcript += text
        return text

    def _await_output(self, markers, quiet_rounds=120, wait_ms=1000, max_reads=10000):
        """Block on pty_read long-polls until a marker line is retained: readiness
        is decided by exact output, never by elapsed time. Non-empty reads return
        immediately (terminal echo arrives as many tiny events), so the failure
        bound counts QUIET long-poll rounds plus a generous total-read cap."""
        quiet = 0
        for _ in range(max_reads):
            for marker in markers:
                if marker in self._transcript:
                    return marker
            chunk = self._drain(wait_ms)
            if chunk is None:
                return None
            quiet = quiet + 1 if chunk == "" else 0
            if quiet >= quiet_rounds:
                return None
        return None

    def _fail_launch(self, message):
        """Launch never reached readiness: refuse with the retained transcript."""
        self._drain()
        raise BrowserLost(message, self._transcript)

    def _set_endpoint(self, port):
        self.port = port
        self.endpoint = "http://127.0.0.1:" + str(port)

    def _launch(self, executable_path):
        opened = self._pty().open(self.profile_dir)
        if opened.get("status") != "ok":
            raise ToolError(
                str(opened.get("reason")) + ": profile_dir " + self.profile_dir
                + " was refused by machine " + self.machine_id + " before Chromium started"
            )
        self._cursor = opened["cursor"]
        self._transcript = ""
        if executable_path is not None:
            resolve = "OMO_EXE=" + _shell_quote(executable_path)
        else:
            resolve = (
                'OMO_EXE="$(python3 -c "from playwright.sync_api import sync_playwright;'
                '_p=sync_playwright().start();print(_p.chromium.executable_path);_p.stop()"'
                ' 2>/dev/null)"'
            )
        self._pty().write(resolve + "\r")
        mode_flags = "--headless " if self.headless else ""
        self._pty().write(
            "OMO_PORT=\"$(python3 -c \"import base64;exec(base64.b64decode('"
            + _BROWSER_PORT_PROBE + "').decode())\")\""
            + "; printf '%s %s %s\\n' '" + _BROWSER_MARK + "' cdp-port \"$OMO_PORT\""
            + '; "$OMO_EXE" --remote-debugging-port="$OMO_PORT" --user-data-dir='
            + _shell_quote(self.profile_dir)
            + " " + mode_flags + "--no-first-run --no-default-browser-check about:blank"
            + "; OMO_STATUS=$?"
            + "; printf '%s %s %s\\n' '" + _BROWSER_MARK + "' chromium-exited \"$OMO_STATUS\""
            + '; [ "$OMO_STATUS" = 0 ] && exit\r'
        )
        marker = self._await_output([_BROWSER_DEVTOOLS_LINE, _BROWSER_MARK + " chromium-exited"])
        if marker != _BROWSER_DEVTOOLS_LINE:
            self._fail_launch("chromium exited before the DevTools readiness line")
        ports = re.findall(re.escape(_BROWSER_MARK) + r" cdp-port (\d+)", self._transcript)
        if not ports:
            self._fail_launch("the selected cdp port line is missing from the session output")
        self._set_endpoint(int(ports[-1]))
        self._connect()

    def _attach(self, executable_path):
        listed = _Machine(self.machine_id).ptyList()
        names = (
            [entry["name"] for entry in listed.get("sessions", [])]
            if listed.get("status") == "ok"
            else []
        )
        if self.session not in names:
            self._launch(executable_path)
            return
        # The session already runs this profile's Chromium: reconnect to the port
        # retained in its output instead of starting a competing process.
        self._cursor = None
        self._transcript = ""
        self._drain()
        ports = re.findall(re.escape(_BROWSER_MARK) + r" cdp-port (\d+)", self._transcript)
        if not ports:
            self._fail_launch("an existing browser session retains no cdp port line")
        self._set_endpoint(int(ports[-1]))
        self._connect()

    def _connect(self):
        chromium = _browser_playwright_instance().chromium
        try:
            self._browser = chromium.connect_over_cdp(self.endpoint)
        except ToolError:
            raise
        except Exception as error:
            self._drain()
            raise BrowserLost(
                "connect_over_cdp to " + str(self.endpoint) + " failed: " + str(error),
                self._transcript,
            )


    def is_connected(self):
        return self._browser is not None and self._browser.is_connected()

    def _lost(self, message):
        """Loss detection (#1275 clause 6): drop the client, attach the transcript."""
        self._shutdown(kill=False)
        _browser_clients.pop((self.machine_id, self.profile_dir), None)
        self._drain()
        return BrowserLost(message, self._transcript)

    def _alive(self):
        if not self.is_connected():
            raise self._lost("chromium exited or its CDP connection is gone")
        return self._browser

    def _reconnect(self):
        """A stale connection is discarded and re-attached over the retained
        endpoint; a dead Chromium surfaces as browser_lost, never a silent
        replacement launch against the same profile."""
        self._shutdown(kill=False)
        try:
            self._connect()
        except BrowserLost:
            _browser_clients.pop((self.machine_id, self.profile_dir), None)
            raise

    @property
    def browser(self):
        return self._alive()

    @property
    def contexts(self):
        return self._alive().contexts

    @property
    def context(self):
        contexts = self._alive().contexts
        if not contexts:
            raise self._lost("the connected chromium exposes no browser context")
        return contexts[0]

    @property
    def pages(self):
        return self.context.pages

    def _shutdown(self, kill):
        browser = self._browser
        self._browser = None
        if browser is None:
            return
        if kill:
            try:
                # CDP Browser.close ends Chromium itself; a clean exit also ends
                # the tmux session, whose launch line exits the shell on status 0.
                browser.new_browser_cdp_session().send("Browser.close")
            except Exception:
                pass
        try:
            browser.close()
        except Exception:
            pass

    def close(self):
        """End Chromium and the owned tmux session; the profile dir is kept."""
        _browser_clients.pop((self.machine_id, self.profile_dir), None)
        self._shutdown(kill=True)
        self._drain()
        try:
            self._pty().close()
        except ToolError:
            pass


def browser(machine_id, *, headless=True, profile_dir=None, executable_path=None):
    """#1275 recipe: Chromium in a cell-owned tmux session, driven over CDP."""
    profile = (
        profile_dir
        if profile_dir is not None
        else os.path.join(os.getcwd(), ".openomni", "browser-profile")
    )
    key = (machine_id, profile)
    client = _browser_clients.get(key)
    if client is not None:
        if client.headless != bool(headless):
            raise ToolError(
                "a live browser client for this profile is "
                + ("headless" if client.headless else "headed")
                + "; close() it before switching display modes"
            )
        if not client.is_connected():
            client._reconnect()
        return client
    client = BrowserClient(machine_id, profile, bool(headless))
    client._attach(executable_path)
    _browser_clients[key] = client
    return client


def _browser_close_all():
    """Interpreter close: close client objects and their Chromiums (which ends
    the owned tmux sessions); persistent profiles are never deleted."""
    for _client in list(_browser_clients.values()):
        _client._shutdown(kill=True)
    _browser_clients.clear()
    instance = _browser_playwright["instance"]
    _browser_playwright["instance"] = None
    if instance is not None:
        try:
            instance.stop()
        except Exception:
            pass

tool = _Tools()
_scope = {
    "__name__": "__main__",
    "tool": tool,
    "ToolError": ToolError,
    "parallel": parallel,
    "completion": completion,
    "codemode": _Codemode(),
    "browser": browser,
    "BrowserLost": BrowserLost,
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
_browser_close_all()
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

/** EOF-first close grace (#1275): time the driver gets to run its cleanup before SIGKILL. */
const DRIVER_EXIT_GRACE_MS = 2_000;

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
  private readonly lock = Semaphore.makeUnsafe(1);
  private readonly lifetime = new AbortController();
  private readonly exits = new Set<Deferred.Deferred<void>>();
  private readonly processExits = new WeakMap<ChildProcessWithoutNullStreams, Deferred.Deferred<void>>();

  run(request: Machine.CellRequest, callTool: CellToolCaller, signal?: AbortSignal): Effect.Effect<Machine.CellResult, CodeError> {
    return Effect.suspend(() => {
      const cancellation = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      const output = { stdout: "", stderr: "" };
      const cancelled = (): Machine.CellResult => ({ status: "cancelled", cellId: request.cellId, output: { ...output } });
      if (cancellation.aborted) return Effect.succeed(cancelled());
      return this.lock.withPermits(1)(this.execute(request, callTool, output)).pipe(
        Effect.raceFirst(onAbort(cancellation, Effect.sync(cancelled))),
        Effect.timeoutOption(request.timeoutMs),
        Effect.map((result): Machine.CellResult => result._tag === "Some" ? result.value : { status: "timed_out", cellId: request.cellId, output: { ...output } }),
      );
    });
  }

  peek(cellId: string): Machine.CellOutput | undefined {
    return this.pending?.cellId === cellId ? { ...this.pending.output } : undefined;
  }

  close(): Effect.Effect<void, CodeError> {
    return Effect.gen({ self: this }, function* () {
      this.lifetime.abort();
      const process = this.process;
      if (process) {
        // EOF-first close: the driver loop breaks on stdin EOF and runs its
        // browser cleanup (#1275) before exiting; stdin.end on a torn-down pipe
        // is ignored because the SIGKILL below is the authoritative teardown.
        yield* Effect.try({ try: () => { process.stdin.end(); }, catch: decodeCodeFailure("driver.stdin") }).pipe(Effect.ignore);
        const exited = this.processExits.get(process);
        if (exited !== undefined) yield* Deferred.await(exited).pipe(Effect.timeoutOption(DRIVER_EXIT_GRACE_MS));
        yield* this.discard(process);
      }
      yield* Effect.forEach([...this.exits], Deferred.await, { discard: true });
    });
  }

  private execute(request: Machine.CellRequest, callTool: CellToolCaller, output: PendingCell["output"]): Effect.Effect<Machine.CellResult, CodeError> {
    return Effect.scoped(Effect.gen({ self: this }, function* () {
      const process = this.process ?? (yield* this.start());
      const frames = yield* Queue.unbounded<string | DriverFailure>();
      const pending: PendingCell = { cellId: request.cellId, process, frames, output, inFlight: new Set() };
      this.pending = pending;
      return yield* Effect.gen({ self: this }, function* () {
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
      }).pipe(Effect.ensuring(Effect.gen({ self: this }, function* () {
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
    return Effect.gen({ self: this }, function* () {
      if (frame.cellId !== pending.cellId) {
        return yield* this.write(pending.process, { status: "failed", error: `tool call refused: cell ${frame.cellId} is not the running cell`, callId: frame.callId });
      }
      if (pending.inFlight.has(frame.callId)) return;
      pending.inFlight.add(frame.callId);
      yield* Effect.forkScoped(Effect.suspend(() => callTool({ cellId: pending.cellId, name: frame.name, arguments: frame.arguments })).pipe(
        Effect.catchCause((cause) => Effect.succeed({ status: "failed", error: Cause.pretty(cause) } as const)),
        Effect.flatMap((answer) => this.pending === pending ? this.write(pending.process, { ...answer, callId: frame.callId }) : Effect.void),
        Effect.catch((error) => Effect.sync(() => { Queue.offerUnsafe(pending.frames, new DriverFailure({ operation: "driver.write", message: "driver write failed", cause: String(error) })); })),
        Effect.ensuring(Effect.sync(() => { pending.inFlight.delete(frame.callId); })),
      ));
    });
  }

  private write(process: ChildProcessWithoutNullStreams, value: Machine.CellRequest | (Machine.ToolCallResult & { callId: string })): Effect.Effect<void, CodeError> {
    return Effect.try({ try: () => { process.stdin.write(`${JSON.stringify(value)}\n`); }, catch: decodeCodeFailure("driver.write") });
  }

  private start(): Effect.Effect<ChildProcessWithoutNullStreams, CodeError> {
    return Effect.gen({ self: this }, function* () {
      const exited = yield* Deferred.make<void>();
      const process = yield* Effect.try({ try: () => spawn("python3", ["-u", "-c", PYTHON_DRIVER]), catch: decodeCodeFailure("driver.spawn") });
      this.exits.add(exited);
      this.processExits.set(process, exited);
      process.once("close", () => { this.exits.delete(exited); Deferred.doneUnsafe(exited, Exit.void); });
      const lines = createInterface({ input: process.stdout });
      this.process = process;
      this.lines = lines;
      lines.on("line", (line) => {
        if (this.pending?.process === process) Queue.offerUnsafe(this.pending.frames, line);
      });
      const fail = (message: string) => {
        if (this.process === process) { this.process = undefined; this.lines = undefined; }
        if (this.pending?.process === process) Queue.offerUnsafe(this.pending.frames, new DriverFailure({ operation: "driver.process", message, cause: message }));
      };
      process.once("error", (error) => fail(error.message));
      process.once("exit", (code, signal) => fail(`python3 exited before replying (code=${String(code)}, signal=${signal})`));
      return process;
    });
  }

  private discard(process: ChildProcessWithoutNullStreams): Effect.Effect<void, CodeError> {
    return Effect.gen({ self: this }, function* () {
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
