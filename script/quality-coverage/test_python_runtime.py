"""Additional original-source and process-boundary regression oracles."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

from coverage.parser import PythonParser

if TYPE_CHECKING:
    from .test_python import ADAPTER, command, counts, execute_native, manifest, prepare
    from .python import json_arcs, json_array, decode_json, json_integer, json_object, json_string
else:
    from test_python import ADAPTER, command, counts, execute_native, manifest, prepare
    from python import json_arcs, json_array, decode_json, json_integer, json_object, json_string

CONTROL_FLOW = '''
from contextlib import contextmanager
def decorate(f):
    return f
@contextmanager
def context():
    yield 1
@decorate
def function(value):
    try:
        with context() as resource:
            if value:
                return resource
            raise LookupError()
    except LookupError:
        return 2
    finally:
        marker = 1
for value in [True, False]:
    function(value)
    while value:
        value = False
        continue
    else:
        marker = 2
match marker:
    case 1:
        never = 1
    case 2:
        selected = 1
for flag in [True, False]:
    if flag:
        @decorate
        def conditional():
            return 3
    if (
        flag
        and marker
    ):
        selected = conditional()
    if flag or (
        marker and selected
    ):
        selected = 4
'''


def test_arc_lines_when_compared_to_unmodified_native_coverage() -> None:
    # Given original source containing decorators, with, finally and loop exits.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = str(directory / "target.py")
        _ = Path(path).write_text(CONTROL_FLOW)
        row, = manifest(directory, {path: CONTROL_FLOW})
        native_script = '''
import coverage, json, runpy, sys
from coverage.files import canonical_filename
cov = coverage.Coverage(branch=True, timid=True, concurrency=["thread"], config_file=False, data_file=sys.argv[2])
cov.set_option("report:exclude_lines", [])
cov.set_option("report:partial_branches", [])
cov.set_option("report:partial_branches_always", [])
cov.start()
runpy.run_path(sys.argv[1], run_name="__main__")
cov.stop()
data = cov.get_data()
path = canonical_filename(sys.argv[1])
print(json.dumps({"arcs": data.arcs(path), "lines": data.lines(path)}))
'''
        native = subprocess.run([sys.executable, "-c", native_script, path, str(directory / "native.coverage")],
                                capture_output=True, text=True, timeout=15, check=True)
        # When both the native coverage engine and adapter execute it.
        run = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
        assert run.returncode == 0, run.stderr
        actual = counts(directory, row)
        parser = PythonParser(text=CONTROL_FLOW, filename=path, exclude=None)
        parser.parse_source()
        data = json_object(decode_json(native.stdout))
        native_arcs = parser.translate_arcs(set(json_arcs(data["arcs"])))
        native_lines = parser.translate_lines([json_integer(line) for line in json_array(data["lines"])])
        # Then every static arc and executable line has the same covered state.
        for arc in row["arcs"]:
            assert [value > 0 for value in actual["b"][arc["id"]]] == [
                (arc["line"], target) in native_arcs for target in arc["targets"]
            ], (arc, actual, native_arcs)
        assert {line for line, hit in actual["lines"].items() if hit} == native_lines & set(row["lines"])


def test_annotations_when_future_annotations_preserve_signature_strings() -> None:
    # Given annotations that the compiler stores as unevaluated source strings.
    source = '''
from __future__ import annotations
import inspect
def function(a: (lambda: 1) or int) -> str | None:
    return None
print(str(inspect.signature(function)))
print(function.__annotations__)
'''
    row, _ = execute_native(source)
    assert len(row["coverage"]["f"]) == 1
    assert not row["coverage"]["b"]


def test_counter_totals_when_multiple_threads_execute_same_statement() -> None:
    # Given four threads released by a barrier rather than a timing delay.
    source = '''
import threading
barrier = threading.Barrier(5)
def worker():
    barrier.wait()
    for i in range(300):
        result = i + 1
threads = [threading.Thread(target=worker) for _ in range(4)]
for thread in threads:
    thread.start()
barrier.wait()
for thread in threads:
    thread.join()
'''
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = "threaded.py"
        row, = manifest(directory, {path: source})
        # When native background threads share the mmap accumulator.
        result = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
        assert result.returncode == 0, result.stderr
        hit = counts(directory, row)
        # Then no read/modify/write increment was lost.
        key = next(key for key, location in row["coverage"]["statementMap"].items()
                   if location["start"]["line"] == 7)
        assert hit["s"][key] == 1200, hit
        assert hit["f"]["0"] == 4


def test_type_only_and_unicode_when_source_ranges_are_utf16() -> None:
    # Given a supplementary Unicode character before a same-line statement.
    source = 'text = "😀"; value = 2\ntype Alias = int\nunused: int\n'
    # When original-source maps are prepared.
    result = prepare("unicode.py", source)
    # Then ranges use coordinator UTF-16 columns, and type-only entries are absent.
    assert len(result["coverage"]["s"]) == 2
    assert result["coverage"]["statementMap"]["1"]["start"] == {"line": 1, "column": 13}
    assert result == prepare("unicode.py", source)


def test_prepare_failure_when_source_contains_coverage_exclusions() -> None:
    # Given a source directive forbidden by the frozen instrumentation contract.
    source = 'if True:  # pragma: no cover\n    value = 1\n'
    # When the source is analyzed rather than silently excluded.
    result = subprocess.run([sys.executable, str(ADAPTER), "prepare"],
                            input=json.dumps({"path": "excluded.py", "source": source}),
                            capture_output=True, text=True, timeout=15, check=False)
    # Then analysis fails; the directive is not a coverage exemption.
    assert result.returncode != 0


def test_manifest_failure_when_maps_or_slots_are_stale() -> None:
    # Given two independent corruptions of the coordinator's manifest.
    for corruption in ("map", "offset"):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path = "stale.py"
            row, = manifest(directory, {path: "value = 1\n"})
            if corruption == "map":
                row["coverage"]["s"]["0"] = 1
            else:
                row["lineOffset"] = row["offset"]
            _ = (directory / "python-files.json").write_text(json.dumps([row]))
            # When execution attempts to load that manifest.
            result = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
            # Then no stale or aliased counters are accepted.
            assert result.returncode != 0
            assert (directory / "child.failure.json").exists()


def test_exit_when_native_code_sets_exit_status() -> None:
    # Given a target-controlled Python exit.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = "exit.py"
        _ = manifest(directory, {path: 'import sys\nsys.exit(7)\n'})
        # When the target exits through its original API.
        result = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
        # Then the parent observes that exact status, not a manufactured success.
        assert result.returncode == 7
        assert (directory / "child.trace.json").exists()
        assert not (directory / "child.failure.json").exists()


def test_loader_when_code_is_compiled_but_not_executed() -> None:
    # Given an owned source whose code is requested through a real loader.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = str(directory / "entry.py")
        other = str(directory / "other.py")
        source = f'''
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("other", {other!r})
code = loader.get_code("other")
assert code is not None
'''
        rows = manifest(directory, {
            path: source,
            other: 'from __future__ import annotations\nvalue = 42\n',
        })
        # When the code is compiled without importing/executing its module.
        result = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
        # Then compile alone never credits a statement or marks a source loaded.
        assert result.returncode == 0, result.stderr
        assert decode_json((directory / "child.loaded.json").read_text()) == [path]
        assert counts(directory, rows[1])["s"] == {"0": 0, "1": 0}


def test_local_annotations_when_compiler_never_evaluates_them() -> None:
    # Given local variable annotations and lazy type-parameter bounds.
    source = '''
def function[T: (lambda: int)]():
    value: (lambda: str) = 1
    return value
print(function())
'''
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = "local-types.py"
        row, = manifest(directory, {path: source})
        # When the function executes without evaluating its type metadata.
        result = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
        # Then there is only one runtime function entry, not unreachable lambdas.
        assert result.returncode == 0, result.stderr
        assert result.stdout == b"1\n"
        assert len(row["coverage"]["f"]) == 1, row["coverage"]["fnMap"]


def test_import_precedence_when_unowned_module_precedes_owned_module() -> None:
    # Given an earlier native import candidate and a later manifest candidate.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        earlier = directory / "earlier"
        later = directory / "later"
        earlier.mkdir()
        later.mkdir()
        _ = (earlier / "other.py").write_text('print("earlier")\n')
        path = str(directory / "entry.py")
        source = f'import sys\nsys.path[:0] = [{str(earlier)!r}, {str(later)!r}]\nimport other\n'
        rows = manifest(directory, {path: source, str(later / "other.py"): 'print("owned")\n'})
        # When native import resolution selects the first matching file.
        result = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
        # Then manifest membership never changes which module executes.
        assert result.returncode == 0, result.stderr
        assert result.stdout == b"earlier\n"
        assert counts(directory, rows[1])["s"] == {"0": 0}


def test_run_path_when_owned_source_uses_native_execution_api() -> None:
    # Given runpy's original execution API over an owned physical file.
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        path = str(directory / "entry.py")
        other = str(directory / "other.py")
        _ = Path(other).write_text('print("owned")\n')
        rows = manifest(directory, {
            path: f'import runpy\nrunpy.run_path({other!r})\n',
            other: 'print("owned")\n',
        })
        # When run_path obtains code without SourceFileLoader.
        result = subprocess.run(command(directory, path), capture_output=True, timeout=15, check=False)
        # Then the native API still executes and receives original-source credit.
        assert result.returncode == 0, result.stderr
        assert result.stdout == b"owned\n"
        assert counts(directory, rows[1])["s"] == {"0": 1}
        loaded = json_array(decode_json((directory / "child.loaded.json").read_text()))
        assert {json_string(item) for item in loaded} == {path, other}


if __name__ == "__main__":
    tests = [
        test_arc_lines_when_compared_to_unmodified_native_coverage,
        test_annotations_when_future_annotations_preserve_signature_strings,
        test_counter_totals_when_multiple_threads_execute_same_statement,
        test_type_only_and_unicode_when_source_ranges_are_utf16,
        test_prepare_failure_when_source_contains_coverage_exclusions,
        test_manifest_failure_when_maps_or_slots_are_stale,
        test_exit_when_native_code_sets_exit_status,
        test_loader_when_code_is_compiled_but_not_executed,
        test_local_annotations_when_compiler_never_evaluates_them,
        test_import_precedence_when_unowned_module_precedes_owned_module,
        test_run_path_when_owned_source_uses_native_execution_api,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(json.dumps({"passed": len(tests), "python": sys.version.split()[0]}))
