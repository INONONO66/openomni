"""D945 Python metric/map adapter. JSON stdin, JSON stdout; source never runs here."""
import ast
import copy
import hashlib
import importlib.metadata
import json
import sys
from collections.abc import Callable, Iterable, Mapping, Sequence
from types import EllipsisType, ModuleType
from typing import Protocol, TypedDict, final, override

type Function = ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda
type UnitNode = ast.Module | ast.ClassDef | Function
type JsonValue = None | bool | int | float | str | Sequence[JsonValue] | Mapping[str, JsonValue]
type AstField = ast.AST | list[object] | str | int | float | complex | bytes | None | EllipsisType


class Point(TypedDict):
    line: int
    column: int


class Range(TypedDict):
    start: Point
    end: Point


class Span(TypedDict):
    start: int
    end: int


class FunctionMap(TypedDict):
    name: str
    decl: Range
    loc: Range


class Halstead(TypedDict):
    algorithm: str
    n1: int
    n2: int
    N1: int
    N2: int
    difficulty: float
    volume: float
    effort: float
    operators: dict[str, int]
    operands: dict[str, int]


class Unit(Span):
    path: str
    kind: str
    name: str
    body: Span
    line: int
    column: int
    endLine: int
    endColumn: int
    cyclomatic: int
    cognitive: int
    halstead: Halstead
    wrapperHash: str


class ComplexityBlock(Protocol):
    complexity: int


class HalsteadReport(Protocol):
    h1: int
    h2: int
    N1: int
    N2: int
    difficulty: float
    volume: float
    effort: float


class HalsteadResult(Protocol):
    total: HalsteadReport


class JsonDecoder(Protocol):
    def loads(self, text: str, /) -> JsonValue: ...


class AstFields(Protocol):
    """Read AST fields; scalar values and list elements remain opaque until visited."""

    def iter_fields(self, node: ast.AST, /) -> Iterable[tuple[str, AstField]]: ...


class FunctionConstructor(Protocol):
    """CPython 3.12 permits omitted optional fields; ast.dump preserves omission."""

    def __call__(self, *, name: str, args: ast.arguments, body: list[ast.stmt],
                 decorator_list: list[ast.expr]) -> ast.FunctionDef: ...


def request_source(decoder: JsonDecoder = json) -> tuple[str, str]:
    request = decoder.loads(sys.stdin.read())
    if not isinstance(request, Mapping):
        raise ValueError("expected JSON object")
    source, path = request["text"], request["path"]
    if not isinstance(source, str) or not isinstance(path, str):
        raise ValueError("expected string text and path")
    return source, path


def location(node: ast.stmt | ast.expr) -> Range:
    if node.end_lineno is None or node.end_col_offset is None:
        raise ValueError("missing source end position")
    return {
        "start": {"line": node.lineno, "column": node.col_offset},
        "end": {"line": node.end_lineno, "column": node.end_col_offset},
    }


def span(node: ast.stmt | ast.expr, source: str) -> Span:
    lines = source.splitlines(keepends=True)
    # CPython columns are UTF-8 byte offsets, the shared ABI uses UTF-16 offsets.
    def offset(line: int, column: int) -> int:
        prefix = "".join(lines[:line - 1])
        prefix += lines[line - 1].encode("utf-8")[:column].decode("utf-8")
        return len(prefix.encode("utf-16-le")) // 2
    loc = location(node)
    return {"start": offset(loc["start"]["line"], loc["start"]["column"]),
            "end": offset(loc["end"]["line"], loc["end"]["column"])}


@final
class OwnBody(ast.NodeTransformer):
    @override
    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.Pass:
        return ast.copy_location(ast.Pass(), node)

    visit_AsyncFunctionDef = visit_FunctionDef

    @override
    def visit_Lambda(self, node: ast.Lambda) -> ast.Constant:
        return ast.copy_location(ast.Constant(value=None), node)

    @override
    def visit_ClassDef(self, node: ast.ClassDef) -> ast.Pass:
        return ast.copy_location(ast.Pass(), node)

    @override
    def visit(self, node: ast.AST) -> ast.AST | list[ast.stmt] | None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return self.visit_FunctionDef(node)
        if isinstance(node, ast.Lambda):
            return self.visit_Lambda(node)
        if isinstance(node, ast.ClassDef):
            return self.visit_ClassDef(node)
        return super().generic_visit(node)


def unit_name(node: UnitNode, default: str) -> str:
    return node.name if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else default


def own_statement(node: ast.stmt) -> ast.stmt:
    clean = OwnBody().visit(copy.deepcopy(node))
    if not isinstance(clean, ast.stmt):
        raise ValueError("expected one own-body statement")
    return clean


def wrapper(node: UnitNode,
            read: Callable[[ModuleType, str], FunctionConstructor] = getattr) -> ast.FunctionDef:
    body: list[ast.stmt] = [ast.Return(value=node.body)] if isinstance(node, ast.Lambda) else node.body
    clean = [own_statement(statement) for statement in body]
    arguments = ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[])
    constructor = read(ast, "FunctionDef")
    wrapped = constructor(name=unit_name(node, "__d945"), args=arguments,
                          body=clean or [ast.Pass()], decorator_list=[])
    return ast.fix_missing_locations(wrapped)


def halstead(node: ast.FunctionDef,
             read: Callable[[ModuleType, str], Callable[[ast.AST], HalsteadResult]] = getattr) -> Halstead:
    """Consume the pinned native report without replacing any metric formulas."""
    native = read(importlib.import_module("radon.metrics"), "h_visit_ast")
    raw = native(ast.Module(body=[node], type_ignores=[])).total
    return {"algorithm": "radon@6.0.1", "n1": raw.h1, "n2": raw.h2,
            "N1": raw.N1, "N2": raw.N2, "difficulty": raw.difficulty,
            "volume": raw.volume, "effort": raw.effort, "operators": {}, "operands": {}}


def unit_extent(node: UnitNode, source: str) -> tuple[Span, Span, Range]:
    if isinstance(node, ast.Module):
        extent: Span = {"start": 0, "end": len(source.encode("utf-16-le")) // 2}
        loc: Range = {"start": {"line": 1, "column": 0},
                      "end": {"line": len(source.split("\n")), "column": len(source.split("\n")[-1])}}
        return extent, extent, loc
    extent = span(node, source)
    body: Span = span(node.body, source) if isinstance(node, ast.Lambda) else {
        "start": span(node.body[0], source)["start"], "end": extent["end"]}
    return extent, body, location(node)


def cyclomatic(node: ast.FunctionDef,
               read: Callable[[ModuleType, str], Callable[[ast.AST], Sequence[ComplexityBlock]]] = getattr) -> int:
    native = read(importlib.import_module("radon.complexity"), "cc_visit_ast")
    blocks = native(ast.Module(body=[node], type_ignores=[]))
    if len(blocks) != 1:
        raise ValueError("ambiguous radon function result")
    return blocks[0].complexity


def cognitive(node: ast.FunctionDef,
              read: Callable[[ModuleType, str], Callable[[ast.FunctionDef], int]] = getattr) -> int:
    native = read(importlib.import_module("cognitive_complexity.api"), "get_cognitive_complexity")
    return native(node)


def measure_unit(source: str, path: str, node: UnitNode) -> Unit:
    wrapped = wrapper(node)
    extent, body, loc = unit_extent(node, source)
    return {"path": path,
            "kind": "module" if isinstance(node, ast.Module) else "python-class" if isinstance(node, ast.ClassDef) else "python-function",
            "name": "<module>" if isinstance(node, ast.Module) else unit_name(node, "<lambda>"),
            **extent, "body": body,
            "line": loc["start"]["line"], "column": loc["start"]["column"],
            "endLine": loc["end"]["line"], "endColumn": loc["end"]["column"],
            "cyclomatic": cyclomatic(wrapped),
            "cognitive": cognitive(wrapped),
            "halstead": halstead(wrapped),
            "wrapperHash": hashlib.sha256(ast.dump(wrapped).encode()).hexdigest()}


def metrics(source: str, path: str, tree: ast.Module) -> list[Unit]:
    functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef))]
    ordered = sorted(functions, key=lambda n: (n.lineno, n.col_offset))
    nodes: list[UnitNode] = [tree, *ordered]
    return [measure_unit(source, path, node) for node in nodes]


@final
class Instrument(ast.NodeTransformer):
    def __init__(self, source: str) -> None:
        self.source: str = source
        self.statements: dict[str, Range] = {}
        self.functions: dict[str, FunctionMap] = {}

    def mapped(self, node: ast.stmt | ast.expr) -> Range:
        result = location(node)
        lines = self.source.splitlines()
        for position in (result["start"], result["end"]):
            line = lines[position["line"] - 1]
            prefix = line.encode()[:position["column"]].decode()
            position["column"] = len(prefix.encode("utf-16-le")) // 2
        return result

    def counter(self, dimension: str, identity: str, node: ast.AST) -> ast.stmt:
        statement = ast.parse(f'_d945_counts["{dimension}"]["{identity}"] += 1').body[0]
        return ast.copy_location(statement, node)

    def function(self, node: Function) -> Function:
        identity = str(len(self.functions))
        first = node.body if isinstance(node, ast.Lambda) else node.body[0]
        loc = self.mapped(node)
        loc["start"] = self.mapped(first)["start"]
        self.functions[identity] = {"name": unit_name(node, "<lambda>"),
                                    "decl": self.mapped(node), "loc": loc}
        _ = self.generic_visit(node)
        if isinstance(node, ast.Lambda):
            call = ast.Call(func=ast.Name(id="_d945_enter", ctx=ast.Load()),
                            args=[ast.Constant(value=identity)], keywords=[])
            node.body = ast.Subscript(value=ast.Tuple(elts=[call, node.body], ctx=ast.Load()),
                                      slice=ast.Constant(value=1), ctx=ast.Load())
        else:
            first = node.body[0]
            has_docstring = is_docstring(first)
            node.body.insert(int(has_docstring), self.counter("f", identity, node))
        return node

    visit_FunctionDef = function
    visit_AsyncFunctionDef = function
    visit_Lambda = function

    @override
    def visit(self, node: ast.AST) -> ast.AST:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            return self.function(node)
        return self.generic_visit(node)

    def items(self, node: ast.AST, field: str, old: list[object]) -> list[object]:
        result: list[object] = []
        for index, item in enumerate(old):
            if not isinstance(item, ast.AST):
                result.append(item)
                continue
            if isinstance(item, ast.stmt) and should_count(node, field, index, item):
                identity = str(len(self.statements))
                self.statements[identity] = self.mapped(item)
                result.append(self.counter("s", identity, item))
            result.append(self.visit(item))
        return result

    @override
    def generic_visit(self, node: ast.AST, fields: AstFields = ast) -> ast.AST:
        # Instrument exact AST statement entry, including multiple statements on
        # one line. Preserve docstrings and __future__ placement, never pragma-skip.
        for field, old in fields.iter_fields(node):
            if isinstance(old, list):
                setattr(node, field, self.items(node, field, old))
            elif isinstance(old, ast.AST):
                setattr(node, field, self.visit(old))
        return node


def is_docstring(node: ast.AST | None) -> bool:
    match node:
        case ast.Expr(value=ast.Constant(value=str())):
            return True
        case _:
            return False


def is_future(node: ast.AST) -> bool:
    return isinstance(node, ast.ImportFrom) and node.module == "__future__"


def should_count(parent: ast.AST, field: str, index: int, item: ast.stmt) -> bool:
    docstring = (isinstance(parent, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
                 and field == "body" and index == 0 and is_docstring(item))
    annotation = isinstance(item, ast.AnnAssign) and item.value is None
    return not (docstring or is_future(item) or annotation)


def check_versions() -> dict[str, str]:
    if sys.version_info[:3] != (3, 12, 12):
        raise ValueError("CPython 3.12.12 required")
    versions = {name: importlib.metadata.version(name) for name in ("radon", "cognitive-complexity")}
    if versions != {"radon": "6.0.1", "cognitive-complexity": "1.3.0"}:
        raise ValueError("pinned Python analyzers required")
    return versions


def instrumented_code(tree: ast.Module, instrument: Instrument) -> str:
    rewritten = instrument.visit(copy.deepcopy(tree))
    if not isinstance(rewritten, ast.Module):
        raise ValueError("expected instrumented module")
    rewritten = ast.fix_missing_locations(rewritten)
    # Receipt code is executed only by an explicit coverage/test producer.
    # Keep the module docstring and future imports before the instrumentation.
    first = rewritten.body[0] if rewritten.body else None
    doc = [first] if first is not None and is_docstring(first) else []
    future = doc + [n for n in rewritten.body if is_future(n)]
    rewritten.body = [n for n in rewritten.body if n not in future]
    counters = {"s": {k: 0 for k in instrument.statements}, "f": {k: 0 for k in instrument.functions}}
    prefix = '\n'.join(ast.unparse(n) for n in future) + '\n' + f'''
import atexit as _d945_atexit
import json as _d945_json
import os as _d945_os
_d945_counts = {counters!r}
def _d945_enter(identity):
    _d945_counts["f"][identity] += 1
def _d945_save():
    with open(_d945_os.environ["D945_PY_COUNTERS"], "x") as receipt:
        _d945_json.dump(_d945_counts, receipt)
_d945_atexit.register(_d945_save)
'''
    return prefix + '\n' + ast.unparse(rewritten)


def main() -> None:
    versions = check_versions()
    source, path = request_source()
    tree = ast.parse(source, filename=path)
    measured = metrics(source, path, tree)
    instrument = Instrument(source)
    code = instrumented_code(tree, instrument)
    print(json.dumps({"runtime": sys.version.split()[0], "tools": versions,
                      "units": measured, "statementMap": instrument.statements,
                      "fnMap": instrument.functions, "code": code}, ensure_ascii=False))


if __name__ == "__main__":
    main()
