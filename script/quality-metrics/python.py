"""D945 Python metric/map adapter. JSON stdin, JSON stdout; source never runs here."""
import ast
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import sys
from pathlib import Path
from collections.abc import Callable, Mapping, Sequence
from types import ModuleType
from typing import Protocol, TypedDict, final, override

type Function = ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda
type UnitNode = ast.Module | ast.ClassDef | Function
type JsonValue = None | bool | int | float | str | Sequence[JsonValue] | Mapping[str, JsonValue]


class Point(TypedDict):
    line: int
    column: int


class Range(TypedDict):
    start: Point
    end: Point


class Span(TypedDict):
    start: int
    end: int


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
def check_versions() -> dict[str, str]:
    if sys.version_info[:3] != (3, 12, 12):
        raise ValueError("CPython 3.12.12 required")
    versions = {name: importlib.metadata.version(name) for name in ("radon", "cognitive-complexity")}
    if versions != {"radon": "6.0.1", "cognitive-complexity": "1.3.0"}:
        raise ValueError("pinned Python analyzers required")
    return versions


COLLECTOR = Path(__file__).resolve().parent.parent / "quality-coverage" / "python.py"


def collector_module(location: Path = COLLECTOR) -> ModuleType:
    """The exact collector, executed from its own file; its tests import it the same way."""
    spec = importlib.util.spec_from_file_location("d945_coverage", location)
    if spec is None or spec.loader is None:
        raise ValueError(f"cannot load coverage collector from {location}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


def coverage_maps(path: str, source: str) -> Mapping[str, JsonValue]:
    # The coverage map has exactly one owner: the exact collector in
    # script/quality-coverage/python.py. The ratchet join matches original and
    # collector {statementMap, fnMap} byte for byte, so this adapter loads the
    # collector module and asks it for the same Prepared document it emits.
    prepared = getattr(collector_module(), "Model")(path, source).prepared
    coverage = prepared["coverage"]
    return {"statementMap": coverage["statementMap"],
            "fnMap": {key: {"name": f["name"], "decl": f["decl"], "loc": f["loc"]}
                      for key, f in coverage["fnMap"].items()},
            "code": prepared["code"]}


def main() -> None:
    versions = check_versions()
    source, path = request_source()
    tree = ast.parse(source, filename=path)
    measured = metrics(source, path, tree)
    print(json.dumps({"runtime": sys.version.split()[0], "tools": versions,
                      "units": measured, **coverage_maps(path, source)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
