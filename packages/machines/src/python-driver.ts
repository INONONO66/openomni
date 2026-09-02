export const PYTHON_DRIVER = String.raw`
import array
import ast
import collections
import concurrent.futures
import contextlib
import io
import itertools
import json
import queue
import reprlib
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
        _limit = getattr(_cell_context, "max_output_bytes", None)
        _chunks = []
        _size = 0
        for _chunk in json.JSONEncoder(separators=(",", ":")).iterencode(payload):
            _chunk_size = len(_chunk.encode("utf-8"))
            if _limit is not None and _size + _chunk_size > _limit:
                _chunks = [json.dumps({
                    "kind": "output_limit",
                    "cellId": getattr(_cell_context, "cell_id", "unknown"),
                }, separators=(",", ":"))]
                break
            _chunks.append(_chunk)
            _size += _chunk_size
        sys.__stdout__.write("".join(_chunks) + "\n")
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


class _OutputLimitExceeded(BaseException):
    """Stops a cell before its captured text grows beyond the declared ceiling."""


class _BoundedText(io.TextIOBase):
    def __init__(self, limit):
        self._limit = limit
        self._size = 0
        self._chunks = []

    def write(self, value):
        _size = len(value.encode("utf-8"))
        if self._size + _size > self._limit:
            raise _OutputLimitExceeded()
        self._chunks.append(value)
        self._size += _size
        return len(value)

    def getvalue(self):
        return "".join(self._chunks)

    def flush(self):
        return None


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
                return _answer["value"]
            raise ToolError(_answer["error"])

        return call


def parallel(thunks, max_workers=8):
    """Run zero-argument callables concurrently and preserve input order."""
    _thunks = list(thunks)
    if not _thunks:
        return []
    _cell = getattr(_cell_context, "cell_id", None)
    _limit = getattr(_cell_context, "max_output_bytes", None)

    def _in_cell(_thunk):
        def _run():
            _cell_context.cell_id = _cell
            _cell_context.max_output_bytes = _limit
            return _thunk()

        return _run

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as _executor:
        _futures = [_executor.submit(_in_cell(_thunk)) for _thunk in _thunks]
        concurrent.futures.wait(_futures)
        return [_future.result() for _future in _futures]


def llm(prompt, **kw):
    return tool.llm(prompt=prompt, **kw)


def llm_batched(prompts):
    return parallel([lambda _prompt=_prompt: llm(_prompt) for _prompt in prompts])


tool = _Tools()
_scope = {
    "__name__": "__main__",
    "tool": tool,
    "ToolError": ToolError,
    "parallel": parallel,
    "llm": llm,
    "llm_batched": llm_batched,
}
threading.Thread(target=_read_stdin, name="driver-stdin", daemon=True).start()

# One executor loop keeps cells serial while tool calls made by worker threads
# can independently wait for their callId-routed answers.
while True:
    _request = _cell_requests.get()
    if _request is None:
        break
    _cell_context.cell_id = _request["cellId"]
    _limit = _request["maxOutputBytes"]
    _cell_context.max_output_bytes = _limit
    _stdout = _BoundedText(_limit)
    _stderr = _BoundedText(_limit)
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
            _max_items = max(1, min(16, _limit // 64))
            _container_types = (
                array.array,
                collections.deque,
                dict,
                frozenset,
                list,
                set,
                tuple,
            )
            if isinstance(_value, _container_types) and len(_value) > _max_items:
                raise _OutputLimitExceeded()
            if isinstance(_value, (bytes, str)) and len(_value) > _limit:
                raise _OutputLimitExceeded()
            _renderer = reprlib.Repr()
            _renderer.maxstring = _limit
            _renderer.maxother = _limit
            _renderer.maxlist = _max_items
            _renderer.maxtuple = _max_items
            _renderer.maxset = _max_items
            _renderer.maxfrozenset = _max_items
            _renderer.maxdeque = _max_items
            _renderer.maxarray = _max_items
            _renderer.maxdict = _max_items
            _rendered = _renderer.repr(_value)
            if len(_rendered.encode("utf-8")) > _limit:
                raise _OutputLimitExceeded()
            _result["value"] = _rendered
    except _OutputLimitExceeded:
        _result = {"kind": "output_limit", "cellId": _request["cellId"]}
    except BaseException as _exc:
        # Drop this driver's own exec/eval frame so the reported traceback starts
        # at the caller's code rather than at the harness that ran it.
        _tb = _exc.__traceback__.tb_next if _exc.__traceback__ else None
        _error = _BoundedText(_limit)
        try:
            traceback.print_exception(type(_exc), _exc, _tb, file=_error)
        except _OutputLimitExceeded:
            _result = {"kind": "output_limit", "cellId": _request["cellId"]}
        else:
            _result = {
                "status": "raised",
                "cellId": _request["cellId"],
                "output": {"stdout": _stdout.getvalue(), "stderr": _stderr.getvalue()},
                "error": _error.getvalue(),
            }
    _cell_context.cell_id = None
    if _result.get("kind") == "output_limit":
        _emit(_result)
    else:
        _emit({"kind": "result", "result": _result})
`;
