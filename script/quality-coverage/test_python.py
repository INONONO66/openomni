"""Real CLI regression tests; run with the pinned CPython interpreter."""

from __future__ import annotations

import json
import py_compile
import selectors
import signal
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from .python import Arc, FileCoverage, Prepared
    from .python import decode_prepared, json_array, decode_json, json_object, json_string
else:
    from python import decode_prepared, json_array, decode_json, json_object, json_string

ADAPTER = Path(__file__).with_name("python.py")


class ManifestRow(TypedDict):
    """Row in manifest after processing."""
    coverage: FileCoverage
    lines: list[int]
    arcs: list[Arc]
    code: str
    source: str
    path: str
    offset: int
    lineOffset: int


class CountResult(TypedDict):
    """Result from counts() with typed dimensions."""
    s: dict[str, float]
    f: dict[str, float]
    b: dict[str, list[float]]
    lines: dict[int, float]


def prepare(path: str, source: str) -> Prepared:
    result = subprocess.run(
        [sys.executable, str(ADAPTER), "prepare"],
        input=json.dumps({"path": path, "source": source}),
        text=True, capture_output=True, timeout=15, check=False,
    )
    assert result.returncode == 0, result.stderr
    return decode_prepared(decode_json(result.stdout))


def manifest(directory: Path, sources: dict[str, str]) -> list[ManifestRow]:
    rows: list[ManifestRow] = []
    for path, source in sources.items():
        prepared = prepare(path, source)
        row: ManifestRow = {
            "coverage": prepared["coverage"],
            "lines": prepared["lines"],
            "arcs": prepared["arcs"],
            "code": prepared["code"],
            "source": source,
            "path": prepared["coverage"]["path"],
            "offset": 0,
            "lineOffset": 0,
        }
        rows.append(row)
    offset = 0
    for row in rows:
        row["offset"] = offset
        cov = row["coverage"]
        offset += len(cov["s"]) + len(cov["f"]) + sum(map(len, cov["b"].values()))
    for row in rows:
        row["lineOffset"] = offset
        offset += len(row["lines"])
    _ = (directory / "python-files.json").write_text(json.dumps(rows))
    _ = (directory / "process-size.json").write_text(json.dumps({"slots": offset}))
    return rows


def command(directory: Path, path: str, *args: str) -> list[str]:
    return [sys.executable, str(ADAPTER), "run", str(directory), "child", path, *args]


def execute_native(source: str) -> tuple[ManifestRow, CountResult]:
    """Compare a real source's native and instrumented execution and receipts."""
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = str(directory / "target.py")
        _ = Path(path).write_text(source)
        native = subprocess.run([sys.executable, path], capture_output=True,
                                timeout=15, check=False)
        row, = manifest(directory, {path: source})
        actual = subprocess.run(command(directory, path), capture_output=True,
                                timeout=15, check=False)
        assert native.returncode == 0, native.stderr
        assert actual.returncode == native.returncode, actual.stderr
        assert actual.stdout == native.stdout, (actual.stdout, native.stdout)
        assert (directory / "child.trace.json").exists()
        assert not (directory / "child.failure.json").exists()
        return row, counts(directory, row)


def counts(directory: Path, row: ManifestRow) -> CountResult:
    raw = (directory / "child.counts.bin").read_bytes()
    values = struct.unpack(f"<{len(raw) // 8}d", raw)
    offset = row["offset"]

    # Decode s (statements) dimension
    s_result: dict[str, float] = {}
    for key in row["coverage"]["s"]:
        s_result[key] = values[offset]
        offset += 1

    # Decode f (functions) dimension
    f_result: dict[str, float] = {}
    for key in row["coverage"]["f"]:
        f_result[key] = values[offset]
        offset += 1

    # Decode b (branches) dimension
    b_result: dict[str, list[float]] = {}
    for key, targets in row["coverage"]["b"].items():
        size = len(targets)
        hit = values[offset : offset + size]
        b_result[key] = list(hit)
        offset += size

    # Decode lines
    start = row["lineOffset"]
    lines_result: dict[int, float] = dict(
        zip(row["lines"], values[start : start + len(row["lines"])])
    )

    result: CountResult = {
        "s": s_result,
        "f": f_result,
        "b": b_result,
        "lines": lines_result,
    }
    trace_path = directory / "child.trace.json"
    if trace_path.exists():
        receipt = json_object(decode_json(trace_path.read_text()))
        trace = json_object(json_object(receipt["files"])[row["path"]])
        checked = subprocess.run(
            [sys.executable, str(ADAPTER), "verify-trace"],
            input=json.dumps({
                "path": row["path"], "source": row["source"], **trace,
                "lines": lines_result, "branches": b_result,
                "loaded": row["path"] in json_array(decode_json((directory / "child.loaded.json").read_text())),
            }), capture_output=True, text=True, timeout=15, check=False,
        )
        assert checked.returncode == 0, checked.stderr
        assert decode_json(checked.stdout) == {"valid": True}
    return result


def test_maps_when_same_line_and_unloaded_functions() -> None:
    # Given executable statements sharing a line and an uncalled lambda.
    source = '"""docs"""\nx: int\nx = 1; y = 2\ndef unused(a=1):\n    """docs"""\n    return a\nf = lambda z: z\n'
    # When maps are prepared and the real target is executed.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = str(directory / "target.py")
        row, = manifest(directory, {path: source})
        result = subprocess.run(
            command(directory, path), capture_output=True, timeout=15, check=False
        )
        assert result.returncode == 0, result.stderr
        hit = counts(directory, row)
    # Then AST rows are independent from coverage.py executable lines.
    assert len(row["coverage"]["s"]) == 5, row
    assert len(row["coverage"]["f"]) == 2, row
    assert list(hit["s"].values()) == [1, 1, 1, 0, 1], hit
    assert list(hit["f"].values()) == [0, 0], hit
    assert row["code"] == source
    assert row["coverage"]["statementMap"]["0"]["start"] == {"line": 3, "column": 0}
    assert row["coverage"]["statementMap"]["1"]["start"] == {"line": 3, "column": 7}


SEMANTICS = '''
import asyncio
import inspect
import json
import threading
effects = []
class Bit:
    def __init__(self, name, answers):
        self.name = name
        self.answers = iter(answers)
    def __bool__(self):
        answer = next(self.answers)
        effects.append([self.name, answer])
        return answer
def exercise():
    a = Bit("value", [False])
    b = Bit("unused", [])
    assert (a and b) is a
    a = Bit("context", [False])
    if (a and b) or True:
        effects.append("context-ok")
    a = Bit("nested", [False, False])
    assert ((a and b) or b) is b
    a = Bit("or", [True])
    assert (a or b) is a
    return "done"
def gen(value, /, *, option=3):
    """generator docs"""
    selected = (yield value) and (yield option)
    return selected
async def coro(value, /, *, option=7):
    async def get():
        return option
    return value and await get()
def worker():
    for i in range(100):
        if i % 2:
            effects.append("odd")
exercise()
g = gen(2)
assert next(g) == 2
assert g.send(True) == 3
try:
    g.send("identity")
except StopIteration as end:
    assert end.value == "identity"
assert asyncio.run(coro(True)) == 7
thread = threading.Thread(target=worker)
thread.start()
thread.join()
f = lambda a, /, *, b=2: a or b
assert f(0) == 2
print(json.dumps([effects, str(inspect.signature(gen)), str(inspect.signature(coro)),
                  str(inspect.signature(f)), inspect.isgeneratorfunction(gen),
                  inspect.iscoroutinefunction(coro), gen.__doc__]))
'''


def test_semantics_when_bool_generators_coroutines_and_threads() -> None:
    # Given the same real program with and without instrumentation.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = str(directory / "target.py")
        _ = Path(path).write_text(SEMANTICS)
        native = subprocess.run(
            [sys.executable, path], capture_output=True, timeout=15, check=False
        )
        row, = manifest(directory, {path: SEMANTICS})
        # When the adapter executes that program.
        result = subprocess.run(
            command(directory, path), capture_output=True, timeout=15, check=False
        )
        # Then identity, effects, signatures and async protocols agree exactly.
        assert native.returncode == 0, native.stderr
        assert result.returncode == native.returncode, result.stderr
        assert result.stdout == native.stdout, (result.stdout, native.stdout)
        hit = counts(directory, row)
        assert all(value > 0 for value in hit["f"].values()), hit["f"]
        assert (directory / "child.trace.json").exists()
        assert not (directory / "child.failure.json").exists()


def test_imports_when_manifest_contains_package_and_unloaded_source() -> None:
    # Given a package, its relative import, and an unimported owned file.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = str(directory / "entry.py")
        sources = {
            path: 'import pkg\nimport sys\nprint(pkg.value, sys.argv[1])\n',
            str(directory / "pkg" / "__init__.py"): 'from .part import value\n',
            str(directory / "pkg" / "part.py"): 'value = 42\n',
            str(directory / "unloaded.py"): 'raise RuntimeError("not loaded")\n',
        }
        rows = manifest(directory, sources)
        # When imports are resolved using only the supplied sources.
        result = subprocess.run(
            command(directory, path, "argument"), capture_output=True, timeout=15, check=False
        )
        # Then all loaded sources have counters and the absent import remains zero.
        assert result.returncode == 0, result.stderr
        assert result.stdout == b"42 argument\n"
        loaded = json_array(decode_json((directory / "child.loaded.json").read_text()))
        assert {json_string(path) for path in loaded} == set(list(sources)[:3])
        assert all(value == 0 for value in counts(directory, rows[-1])["s"].values())
        assert counts(directory, rows[2])["s"] == {"0": 1}


def test_native_failure_when_target_raises() -> None:
    # Given a target exception, not an analyzer failure.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = "virtual.py#driver"
        row, = manifest(directory, {path: 'raise RuntimeError("native failure")\n'})
        # When the real target fails.
        result = subprocess.run(
            command(directory, path), capture_output=True, timeout=15, check=False
        )
        # Then Python reports the original exception and coverage survives.
        assert result.returncode == 1
        assert b'native failure' in result.stderr
        assert path.encode() in result.stderr
        assert not (directory / "child.failure.json").exists()
        assert counts(directory, row)["s"] == {"0": 1}
        assert (directory / "child.trace.json").exists()


def test_live_counts_when_parent_kills_blocked_child() -> None:
    # Given a child that signals completion of the measured branch before blocking.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = "kernel.ts#PYTHON_DRIVER"
        source = 'import sys\nx = bool(sys.argv) and True\nif x:\n    print("READY", flush=True)\nsys.stdin.read()\n'
        row, = manifest(directory, {path: source})
        # When an independently observing parent kills it after the exact signal.
        with subprocess.Popen(command(directory, path), stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
            with selectors.DefaultSelector() as selector:
                stdout = child.stdout
                assert stdout is not None
                _ = selector.register(stdout, selectors.EVENT_READ)
                assert selector.select(timeout=15), "Child did not signal"
                assert stdout.readline() == b"READY\n"
            before = counts(directory, row)
            child.send_signal(signal.SIGKILL)
            _ = child.communicate(timeout=15)
            assert child.returncode == -signal.SIGKILL
        # Then mmap counters precede termination and no normal flush is fabricated.
        assert before["s"]["3"] == 1
        assert before["lines"][4] >= 1
        assert any(sum(value) > 0 for value in before["b"].values())
        binary = [key for key, branch in row["coverage"]["branchMap"].items()
                  if branch["type"] == "binary-expr"]
        assert [before["b"][key] for key in binary] == [[0, 1]]
        assert not (directory / "child.trace.json").exists()


def test_unobservable_process_when_owned_source_spawns() -> None:
    # Given an owned source launching an unobservable descendant.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = "unsupported.py"
        _ = manifest(directory, {path: 'import subprocess\nsubprocess.run(["true"], check=True)\n'})
        # When the adapter encounters the unsupported process boundary.
        result = subprocess.run(
            command(directory, path), capture_output=True, timeout=15, check=False
        )
        # Then it fails closed with an analyzer receipt.
        assert result.returncode != 0
        assert json_object(decode_json((directory / "child.failure.json").read_text()))["error"]


if __name__ == "__main__":
    assert ADAPTER.exists(), "Python prepare/run adapter is not implemented"
    _ = py_compile.compile(str(ADAPTER), doraise=True)
    _ = py_compile.compile(__file__, doraise=True)
    tests = [
        test_maps_when_same_line_and_unloaded_functions,
        test_semantics_when_bool_generators_coroutines_and_threads,
        test_imports_when_manifest_contains_package_and_unloaded_source,
        test_native_failure_when_target_raises,
        test_live_counts_when_parent_kills_blocked_child,
        test_unobservable_process_when_owned_source_spawns,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(json.dumps({"passed": len(tests), "python": sys.version.split()[0]}))
