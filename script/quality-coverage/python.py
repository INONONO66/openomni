"""D945 Python collector, pinned to CPython 3.12.12 and coverage.py 7.10.7.

Input membership belongs to the coordinator. This module never inventories files.
The PyTracer data sets are the only producer of line and static arc hits.
"""

from __future__ import annotations

import ast
import atexit
import builtins
import hashlib
import importlib.abc
import importlib.machinery
import importlib.util
import io
import json
import linecache
import mmap
import os
import re
import runpy
import struct
import sys
import threading
import tokenize
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import CodeType, EllipsisType, ModuleType
from typing import Final, Protocol, TypedDict, override

from coverage.files import canonical_filename
from coverage.parser import PythonParser

import coverage


class Point(TypedDict):
    line: int
    column: int


class Range(TypedDict):
    start: Point
    end: Point


class FunctionMap(TypedDict):
    name: str
    decl: Range
    loc: Range
    line: int


class BranchMap(TypedDict):
    type: str
    loc: Range
    locations: list[Range]
    line: int


class FileCoverage(TypedDict):
    path: str
    statementMap: dict[str, Range]
    fnMap: dict[str, FunctionMap]
    branchMap: dict[str, BranchMap]
    s: dict[str, int]
    f: dict[str, int]
    b: dict[str, list[int]]


class Arc(TypedDict):
    id: str
    targets: list[int]
    line: int


class Prepared(TypedDict):
    coverage: FileCoverage
    lines: list[int]
    arcs: list[Arc]
    code: str


class TraceCheck(TypedDict):
    path: str
    source: str
    arcs: list[tuple[int, int]]
    translatedArcs: list[tuple[int, int]]
    lines: dict[str, int | float]
    branches: dict[str, list[int | float]]
    loaded: bool


class ExceptionEdge(Protocol):
    """Consumed fields of CPython's dis exception-table records."""
    start: int
    end: int
    target: int


type JsonValue = None | bool | int | float | str | Sequence[JsonValue] | Mapping[str, JsonValue]


class AuditArgument(Protocol):
    """An audit argument is opaque: the event name alone is consumed."""

    @override
    def __repr__(self) -> str: ...


class AnalyzerError(RuntimeError):
    """A collector failure, distinct from a target Python exception."""


class JsonDecoder(Protocol):
    def loads(self, text: str, /) -> JsonValue: ...


def decode_json(text: str, decoder: JsonDecoder = json) -> JsonValue:
    return decoder.loads(text)


def json_object(value: JsonValue) -> Mapping[str, JsonValue]:
    if not isinstance(value, Mapping):
        raise AnalyzerError("Expected JSON object")
    return value


def json_array(value: JsonValue) -> Sequence[JsonValue]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        raise AnalyzerError("Expected JSON array")
    return value


def json_string(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise AnalyzerError("Expected JSON string")
    return value


def json_integer(value: JsonValue) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise AnalyzerError("Expected JSON integer")
    return value


def json_number(value: JsonValue) -> int | float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise AnalyzerError("Expected JSON number")
    return value


def json_counts[T](value: JsonValue, parse: Callable[[JsonValue], T]) -> dict[str, T]:
    return {key: parse(hits) for key, hits in json_object(value).items()}


def json_branches[T](value: JsonValue, parse: Callable[[JsonValue], T]) -> dict[str, list[T]]:
    return {key: [parse(hit) for hit in json_array(hits)]
            for key, hits in json_object(value).items()}


def json_arcs(value: JsonValue) -> list[tuple[int, int]]:
    arcs: list[tuple[int, int]] = []
    for item in json_array(value):
        pair = json_array(item)
        if len(pair) != 2:
            raise AnalyzerError("Expected arc pair")
        arcs.append((json_integer(pair[0]), json_integer(pair[1])))
    return arcs


def decode_trace(value: JsonValue) -> TraceCheck:
    row = json_object(value)
    loaded = row["loaded"]
    if not isinstance(loaded, bool):
        raise AnalyzerError("Expected loaded boolean")
    return {
        "path": json_string(row["path"]), "source": json_string(row["source"]),
        "arcs": json_arcs(row["arcs"]), "translatedArcs": json_arcs(row["translatedArcs"]),
        "lines": json_counts(row["lines"], json_number),
        "branches": json_branches(row["branches"], json_number),
        "loaded": loaded,
    }


def json_point(value: JsonValue) -> Point:
    point = json_object(value)
    return {"line": json_integer(point["line"]), "column": json_integer(point["column"])}


def json_range(value: JsonValue) -> Range:
    loc = json_object(value)
    return {"start": json_point(loc["start"]), "end": json_point(loc["end"])}


def json_function(value: JsonValue) -> FunctionMap:
    row = json_object(value)
    return {"name": json_string(row["name"]), "decl": json_range(row["decl"]),
            "loc": json_range(row["loc"]), "line": json_integer(row["line"])}


def json_branch(value: JsonValue) -> BranchMap:
    row = json_object(value)
    return {"type": json_string(row["type"]), "loc": json_range(row["loc"]),
            "locations": [json_range(loc) for loc in json_array(row["locations"])],
            "line": json_integer(row["line"])}


def decode_prepared(value: JsonValue) -> Prepared:
    row = json_object(value)
    cov = json_object(row["coverage"])
    coverage_row: FileCoverage = {
        "path": json_string(cov["path"]),
        "statementMap": {key: json_range(loc) for key, loc in json_object(cov["statementMap"]).items()},
        "fnMap": {key: json_function(fn) for key, fn in json_object(cov["fnMap"]).items()},
        "branchMap": {key: json_branch(branch) for key, branch in json_object(cov["branchMap"]).items()},
        "s": json_counts(cov["s"], json_integer), "f": json_counts(cov["f"], json_integer),
        "b": json_branches(cov["b"], json_integer),
    }
    arcs: list[Arc] = []
    for value in json_array(row["arcs"]):
        arc = json_object(value)
        arcs.append({"id": json_string(arc["id"]), "line": json_integer(arc["line"]),
                     "targets": [json_integer(target) for target in json_array(arc["targets"])]})
    return {"coverage": coverage_row, "lines": [json_integer(line) for line in json_array(row["lines"])],
            "arcs": arcs, "code": json_string(row["code"])}


PIN: Final = ("3.12.12", "7.10.7")
PROCESS_EVENTS: Final = frozenset({
    "subprocess.Popen", "os.fork", "os.forkpty", "os.posix_spawn",
    "os.exec", "os.system", "pty.spawn",
})


def check_pin() -> None:
    if (sys.version.split()[0], coverage.__version__) != PIN:
        raise AnalyzerError(f"Requires CPython {PIN[0]} and coverage.py {PIN[1]}")


def is_docstring(node: ast.AST) -> bool:
    match node:
        case ast.Expr(value=ast.Constant(value=str())):
            return True
        case _:
            return False


class Model(ast.NodeVisitor):
    """Accumulate original AST identities before introducing instrumentation."""

    def __init__(self, path: str, source: str) -> None:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT and re.search(
                r"\b(?:pragma\s*:\s*no\s*(?:cover|branch)|coverage\s*:\s*ignore|istanbul\s+ignore)\b",
                token.string, re.IGNORECASE,
            ):
                raise AnalyzerError(f"Coverage exclusion directive: {path}:{token.start[0]}")
        self.path: str = path
        self.source: str = source
        self.source_lines: list[str] = source.splitlines()
        self.tree: ast.Module = ast.parse(source, filename=path)
        _ = compile(self.tree, path, "exec", dont_inherit=True)
        self.parser: PythonParser = PythonParser(text=source, filename=path, exclude=None)
        self.parser.parse_source()
        self.statements: list[ast.stmt] = []
        self.functions: list[ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda] = []
        self.booleans: list[ast.BoolOp] = []
        self.docs: set[ast.AST] = set()
        self.ignored: set[ast.AST] = set()
        future_annotations = any(
            isinstance(node, ast.ImportFrom) and node.module == "__future__"
            and any(alias.name == "annotations" for alias in node.names)
            for node in self.tree.body
        )
        def classify(node: ast.AST, local: bool = False) -> None:
            match node:
                case ast.Module(body=body) | ast.ClassDef(body=body) | ast.FunctionDef(body=body) | ast.AsyncFunctionDef(body=body):
                    if body and is_docstring(body[0]):
                        self.docs.add(body[0])
                case _:
                    pass
            match node:
                case ast.TypeAlias() | ast.type_param():
                    self.ignored.update(ast.walk(node))
                    return
                case ast.AnnAssign(annotation=annotation, simple=simple):
                    # Only simple module/class annotations are evaluated. Even
                    # without a value, attribute/subscript targets still run.
                    if future_annotations or local or not simple:
                        self.ignored.update(ast.walk(annotation))
                case ast.arg(annotation=annotation):
                    if future_annotations and annotation is not None:
                        self.ignored.update(ast.walk(annotation))
                case ast.FunctionDef(returns=annotation) | ast.AsyncFunctionDef(returns=annotation):
                    if future_annotations and annotation is not None:
                        self.ignored.update(ast.walk(annotation))
                case _:
                    pass
            for child in ast.iter_child_nodes(node):
                child_local = local
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and child in node.body:
                    # Defaults, decorators and function annotations belong to
                    # the enclosing scope; only the body changes scope.
                    child_local = not isinstance(node, ast.ClassDef)
                classify(child, child_local)

        classify(self.tree)
        self.visit(self.tree)
        self.sids: dict[ast.AST, str] = {node: str(index) for index, node in enumerate(self.statements)}
        self.fids: dict[ast.AST, str] = {node: str(index) for index, node in enumerate(self.functions)}
        self.bids: dict[tuple[ast.BoolOp, int], str] = {}
        self.prepared: Prepared = self.make_maps()
        digest = hashlib.sha256(source.encode()).hexdigest()[:16]
        self.helper: str = f"_d945_hit_{digest}"
        if any(isinstance(node, ast.Name) and node.id == self.helper for node in ast.walk(self.tree)):
            raise AnalyzerError("Instrumentation name collides with source")

    @override
    def generic_visit(self, node: ast.AST) -> None:
        if node in self.ignored:
            return
        match node:
            case ast.Global() | ast.Nonlocal() | ast.TypeAlias():
                return
            case ast.AnnAssign(value=None):
                # The statement is type-only, but its target and annotation
                # can contain executable expressions in module/class scope.
                pass
            case ast.stmt():
                if node not in self.docs:
                    self.statements.append(node)
            case _:
                pass
        match node:
            case ast.FunctionDef() | ast.AsyncFunctionDef() | ast.Lambda():
                self.functions.append(node)
            case ast.BoolOp():
                self.booleans.append(node)
            case _:
                pass
        super().generic_visit(node)

    def point(self, line: int, byte_column: int) -> Point:
        # Python AST columns are UTF-8 bytes; coordinator/Istanbul use UTF-16.
        prefix = self.source_lines[line - 1].encode()[:byte_column].decode()
        return {"line": line, "column": len(prefix.encode("utf-16-le")) // 2}

    def location(self, node: ast.stmt | ast.expr) -> Range:
        assert node.end_lineno is not None and node.end_col_offset is not None
        return {
            "start": self.point(node.lineno, node.col_offset),
            "end": self.point(node.end_lineno, node.end_col_offset),
        }

    def line_location(self, line: int) -> Range:
        return {
            "start": {"line": line, "column": 0},
            "end": {"line": line, "column": len(self.source_lines[line - 1].encode("utf-16-le")) // 2},
        }

    def make_maps(self) -> Prepared:
        cov: FileCoverage = {
            "path": self.path,
            "statementMap": {self.sids[node]: self.location(node) for node in self.statements},
            "fnMap": {},
            "branchMap": {},
            "s": dict.fromkeys(self.sids.values(), 0),
            "f": dict.fromkeys(self.fids.values(), 0),
            "b": {},
        }
        for node in self.functions:
            name = node.name if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else "(lambda)"
            loc = self.location(node)
            cov["fnMap"][self.fids[node]] = {"name": name, "decl": loc, "loc": loc, "line": node.lineno}
        outgoing: dict[int, list[int]] = {}
        for start, end in sorted(self.parser.arcs()):
            outgoing.setdefault(start, []).append(end)
        arcs: list[Arc] = []
        for line, targets in sorted(outgoing.items()):
            if len(targets) < 2:
                continue
            key = str(len(cov["b"]))
            loc = self.line_location(line)
            cov["branchMap"][key] = {
                "type": "python-arc", "loc": loc, "line": line,
                "locations": [self.line_location(target if target > 0 else line) for target in targets],
            }
            cov["b"][key] = [0] * len(targets)
            arcs.append({"id": key, "line": line, "targets": targets})
        for node in self.booleans:
            for index, operand in enumerate(node.values[:-1]):
                key = str(len(cov["b"]))
                self.bids[node, index] = key
                cov["branchMap"][key] = {
                    "type": "binary-expr", "loc": self.location(node), "line": operand.lineno,
                    "locations": [self.location(operand), self.location(node.values[index + 1])],
                }
                # Stable order: short-circuit, continue.
                cov["b"][key] = [0, 0]
        return {"coverage": cov, "lines": sorted(self.parser.statements), "arcs": arcs, "code": self.source}

    def verify_trace(self, trace: TraceCheck) -> None:
        """Reconcile a normal flush with regenerated code and persistent hits."""
        raw = {(start, end) for start, end in trace["arcs"]}
        translated = self.parser.translate_arcs(raw)
        if translated != {(start, end) for start, end in trace["translatedArcs"]}:
            raise AnalyzerError("Raw and translated Python arcs disagree")
        if raw and not trace["loaded"]:
            raise AnalyzerError("Unloaded Python source has execution arcs")
        executed = {self.parser.first_line(end) for _, end in raw if end > 0}
        counted = {int(line) for line, hits in trace["lines"].items() if hits > 0}
        if executed & self.parser.statements != counted:
            raise AnalyzerError("Python trace and executable line counters disagree")
        # ArcSet persists each native add separately; with-jump translation of
        # an entire set is not interchangeable with singleton translation.
        counted_arcs = {mapped for arc in raw for mapped in self.parser.translate_arcs({arc})}
        for row in self.prepared["arcs"]:
            expected = [(row["line"], target) in counted_arcs for target in row["targets"]]
            actual = [hits > 0 for hits in trace["branches"].get(row["id"], [0] * len(expected))]
            if expected != actual:
                raise AnalyzerError("Python trace and static branch counters disagree")
        slots = {(dimension, key): 0 for dimension in ("s", "f") for key in self.prepared["coverage"][dimension]}
        _ = Instrument(self, slots).visit(self.tree)
        program = BoolCompile(self, dict.fromkeys(self.prepared["coverage"]["b"], 0))
        if raw - possible_trace_arcs(program.code):
            raise AnalyzerError("Python raw arc is impossible in regenerated code")


def exception_edges(code: CodeType, read: Callable[[BoolDis.Bytecode, str], list[ExceptionEdge]] = getattr) -> list[ExceptionEdge]:
    return read(BoolDis.Bytecode(code), "exception_entries")


def possible_trace_arcs(code: CodeType) -> set[tuple[int, int]]:
    """CPython line-event transitions, including handlers and generator resumes.

    This is a static possibility model, not coverage: counters still determine
    execution. Exception unwinds may leave any instruction's active line.
    """
    instructions = list(BoolDis.get_instructions(code))
    indices = {instruction.offset: index for index, instruction in enumerate(instructions)}
    # Present on pinned CPython 3.12, absent from typeshed's Bytecode stub.
    handlers = exception_edges(code)
    positions = {offset: line for start, end, line in code.co_lines() for offset in range(start, end, 2)}
    pending = [(index + 1, -code.co_firstlineno if instruction.arg == 0 else positions[instruction.offset] or code.co_firstlineno, False)
               for index, instruction in enumerate(instructions) if instruction.opname == "RESUME"]
    seen: set[tuple[int, int, bool]] = set()
    arcs: set[tuple[int, int]] = set()

    def successors(instruction: BoolDis.Instruction, index: int, previous: int) -> None:
        for handler in handlers:
            if handler.start <= instruction.offset < handler.end:
                pending.append((indices[handler.target], previous, False))
        if instruction.opname in {"RETURN_VALUE", "RETURN_CONST", "RAISE_VARARGS", "RERAISE", "YIELD_VALUE"}:
            return
        if instruction.opcode in BoolDis.hasjrel or instruction.opcode in BoolDis.hasjabs:
            target = instruction_value(instruction)
            if not isinstance(target, int):
                raise AnalyzerError("Python jump has no integer destination")
            pending.append((indices[target], previous, target <= instruction.offset))
            if instruction.opname in {"JUMP_FORWARD", "JUMP_BACKWARD", "JUMP_BACKWARD_NO_INTERRUPT"}:
                return
        pending.append((index + 1, previous, False))

    while pending:
        state = pending.pop()
        if state in seen:
            continue
        seen.add(state)
        index, previous, backward = state
        if index >= len(instructions):
            continue
        instruction = instructions[index]
        line = positions[instruction.offset]
        if line is not None and (line != previous or backward):
            arcs.add((previous, line))
            previous = line
        arcs.add((previous, -code.co_firstlineno))
        successors(instruction, index, previous)
    for constant in code_constants(code):
        if isinstance(constant, CodeType):
            arcs.update(possible_trace_arcs(constant))
    return arcs


class Instrument(ast.NodeTransformer):
    """Insert entry probes without wrappers around functions or suspension."""

    def __init__(self, model: Model, slots: dict[tuple[str, str], int]) -> None:
        self.model: Model = model
        self.slots: dict[tuple[str, str], int] = slots

    def probe(self, dimension: str, key: str, node: ast.AST) -> ast.Call:
        call = ast.Call(
            func=ast.Name(id=self.model.helper, ctx=ast.Load()),
            args=[ast.Constant(self.slots[dimension, key])], keywords=[],
        )
        for child in ast.walk(call):
            _ = ast.copy_location(child, node)
        return call

    @override
    def visit(self, node: ast.AST) -> ast.AST | list[ast.stmt]:
        if node in self.model.ignored:
            return node
        function_key = self.model.fids.get(node)
        statement_key = self.model.sids.get(node)
        result = super().generic_visit(node)
        assert isinstance(result, ast.AST)
        match result:
            case ast.FunctionDef(body=body) | ast.AsyncFunctionDef(body=body):
                assert function_key is not None
                position = 1 if body and is_docstring(body[0]) else 0
                anchor = body[position] if position < len(body) else body[0]
                probe = ast.Expr(value=self.probe("f", function_key, anchor))
                _ = ast.copy_location(probe, anchor)
                body.insert(position, probe)
            case ast.Lambda(body=body):
                assert function_key is not None
                result.body = ast.copy_location(ast.Subscript(
                    value=ast.Tuple(elts=[self.probe("f", function_key, body), body], ctx=ast.Load()),
                    slice=ast.Constant(1), ctx=ast.Load(),
                ), body)
            case _:
                pass
        if statement_key is not None:
            assert isinstance(result, ast.stmt)
            if isinstance(result, ast.ImportFrom) and result.module == "__future__":
                return result
            anchor: ast.AST = result
            match result:
                case ast.FunctionDef(decorator_list=decorators) | ast.AsyncFunctionDef(decorator_list=decorators) | ast.ClassDef(decorator_list=decorators):
                    if decorators:
                        anchor = decorators[0]
                case _:
                    pass
            probe = ast.copy_location(ast.Expr(value=self.probe("s", statement_key, anchor)), anchor)
            return [probe, result]
        return result


import copy as BoolCopy
import dis as BoolDis
import marshal as BoolMarshal
from collections.abc import Callable as BoolCallable


type CodeConstant = None | EllipsisType | bool | int | float | complex | str | bytes | CodeType | tuple[CodeConstant, ...] | frozenset[CodeConstant]
type AstField = ast.AST | CodeConstant | list[AstField]


class CodeConstants(Protocol):
    @property
    def co_consts(self) -> tuple[CodeConstant, ...]: ...


class InstructionValue(Protocol):
    @property
    def argval(self) -> CodeConstant: ...


def code_constants(code: CodeType) -> tuple[CodeConstant, ...]:
    view: CodeConstants = code
    return view.co_consts


def instruction_value(instruction: InstructionValue) -> CodeConstant:
    return instruction.argval


def ast_fields(node: ast.AST, reader: Callable[[ast.AST], Iterator[tuple[str, AstField]]] = ast.iter_fields) -> Iterator[tuple[str, AstField]]:
    return reader(node)


@dataclass(frozen=True)
class BoolPredicate:
    """Logical continuations of a compiler-visible truth test."""

    yes: tuple[int, ...]
    no: tuple[int, ...]
    comparisons: int = 0


@dataclass(frozen=True)
class BoolCode:
    code: CodeType
    edges: dict[tuple[int, int], tuple[int, ...]]
    offsets: frozenset[int]


@dataclass(frozen=True)
class BoolProgram:
    """Executable code and identity-keyed BRANCH maps, including nested code."""

    code: CodeType
    codes: dict[int, BoolCode]
    helper: str


def transformed_node(node: ast.AST, visit: Callable[[ast.AST], ast.AST | list[ast.AST] | None]) -> ast.AST:
    result = visit(node)
    assert isinstance(result, ast.AST)
    return result


class ExecutableTransformer(ast.NodeTransformer):
    """Visit only executable nodes, preserving the transformer's AST contract."""

    def __init__(self, ignored: set[ast.AST]) -> None:
        self.ignored: set[ast.AST] = ignored

    @override
    def visit(self, node: ast.AST) -> ast.AST:
        if node in self.ignored:
            return node
        return transformed_node(node, super().visit)


class BoolMarkers(ExecutableTransformer):
    """Keep compiler_jump_if structures visible; mark only value leaves."""

    def __init__(self, model: Model, branch_slots: dict[str, int]) -> None:
        super().__init__(model.ignored)
        self.bids: dict[tuple[ast.BoolOp, int], str] = model.bids
        self.branch_slots: dict[str, int] = branch_slots
        self.slots: dict[ast.BoolOp, tuple[int, ...]] = {}
        self.leaves: set[ast.expr] = set()
        self.helper: str = model.helper + "_bool"
        identifiers: set[str] = set()
        for node in ast.walk(model.tree):
            for _, value in ast_fields(node):
                if isinstance(value, str):
                    identifiers.add(value)
                elif isinstance(value, list):
                    identifiers.update(item for item in value if isinstance(item, str))
        while self.helper in identifiers:
            self.helper += "_"

    @override
    def visit_BoolOp(self, node: ast.BoolOp) -> ast.BoolOp:
        # Model deliberately omits non-executable annotations and other type ASTs.
        if (node, 0) not in self.bids:
            return node
        self.slots[node] = tuple(
            self.branch_slots[self.bids[node, index]]
            for index in range(len(node.values) - 1)
        )
        node.values = [self.protect(value) for value in node.values]
        return node

    def protect(self, node: ast.expr) -> ast.expr:
        if isinstance(node, ast.BoolOp):
            return self.visit_BoolOp(node)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            node.operand = self.protect(node.operand)
            return node
        if isinstance(node, ast.IfExp):
            node.test = self.protect(node.test)
            node.body = self.protect(node.body)
            node.orelse = self.protect(node.orelse)
            return node
        if isinstance(node, ast.Compare):
            node.left = self.protect(node.left)
            node.comparators = [self.protect(value) for value in node.comparators]
            return node
        visited = self.visit(node)
        assert isinstance(visited, ast.expr)
        call = ast.Call(
            func=ast.Name(id=self.helper, ctx=ast.Load()),
            args=[ast.Constant(len(self.leaves))], keywords=[],
        )
        result = ast.copy_location(ast.Subscript(
            value=ast.Tuple(elts=[call, visited], ctx=ast.Load()),
            slice=ast.Constant(1), ctx=ast.Load(),
        ), node)
        self.leaves.add(result)
        return result


class BoolShadow(ExecutableTransformer):
    """Give value-mode transitions separate locations without executable edits."""

    def __init__(self, slots: dict[ast.BoolOp, tuple[int, ...]],
                 leaves: set[ast.expr], ignored: set[ast.AST]) -> None:
        super().__init__(ignored)
        self.slots: dict[ast.BoolOp, tuple[int, ...]] = slots
        self.leaves: set[ast.expr] = leaves
        self.predicates: dict[ast.AST, BoolPredicate] = {}
        self.tags: dict[int, BoolPredicate] = {}

    def continuations(self, node: ast.AST, yes: tuple[int, ...] = (),
                      no: tuple[int, ...] = ()) -> None:
        if node in self.ignored:
            return
        if isinstance(node, ast.BoolOp) and node in self.slots:
            conjunction = isinstance(node.op, ast.And)
            slots = self.slots[node]
            for index, value in enumerate(node.values):
                if index == len(slots):
                    self.continuations(value, yes, no)
                elif conjunction:
                    self.continuations(value, (slots[index] + 1,), (slots[index],) + no)
                else:
                    self.continuations(value, (slots[index],) + yes, (slots[index] + 1,))
            return
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            self.continuations(node.operand, no, yes)
            return
        if isinstance(node, ast.IfExp):
            self.continuations(node.test)
            self.continuations(node.body, yes, no)
            self.continuations(node.orelse, yes, no)
            return
        if (yes or no) and isinstance(node, ast.Compare):
            self.predicates[node] = BoolPredicate(yes, no, len(node.ops))
        elif (yes or no) and node in self.leaves:
            self.predicates[node] = BoolPredicate(yes, no)
        # Ordinary expression children are evaluated in value mode. Their own
        # IfExp tests / comprehension filters still have independent J graphs.
        for child in ast.iter_child_nodes(node):
            self.continuations(child)

    @override
    def visit_BoolOp(self, node: ast.BoolOp) -> ast.BoolOp:
        if node not in self.slots:
            return node
        _ = self.generic_visit(node)
        values = node.values
        tail: ast.expr = values[-1]
        conjunction = isinstance(node.op, ast.And)
        for index in reversed(range(len(values) - 1)):
            slot = self.slots[node][index]
            binary = ast.copy_location(ast.BoolOp(op=node.op, values=[values[index], tail]), node)
            self.predicates[binary] = BoolPredicate(
                (slot + 1,) if conjunction else (slot,),
                (slot,) if conjunction else (slot + 1,),
            )
            tail = binary
        assert isinstance(tail, ast.BoolOp)
        return tail

    def locate(self, tree: ast.AST) -> None:
        for index, node in enumerate(ast.walk(tree), 1):
            if node in self.ignored:
                continue
            if isinstance(node, (ast.expr, ast.stmt, ast.arg, ast.keyword, ast.alias, ast.excepthandler)):
                if not hasattr(node, "lineno"):
                    continue
                column = index * 2
                node.col_offset = column
                node.end_col_offset = column + 1
                predicate = self.predicates.get(node)
                if predicate is not None:
                    self.tags[column] = predicate

    def comparison_stages(self, code: CodeType, instructions: list[BoolDis.Instruction]) -> dict[int, int]:
        primitive = {"COMPARE_OP", "IS_OP", "CONTAINS_OP"}
        stages: dict[int, int] = {}
        occurrences: dict[int, int] = {}
        # Duplicated while tests and finally suites repeat the complete chain.
        # COPY immediately before its jump identifies value-mode early tests.
        for instruction in instructions:
            positions = instruction.positions
            column = positions.col_offset if positions is not None else None
            predicate = self.tags.get(column) if column is not None else None
            if predicate is not None and predicate.comparisons and instruction.opname in primitive:
                assert column is not None
                count = occurrences.get(column, 0)
                stages[instruction.offset] = count % predicate.comparisons
                occurrences[column] = count + 1
        for column, count in occurrences.items():
            if count % self.tags[column].comparisons:
                raise AnalyzerError(f"Incomplete BoolOp comparison chain: {code.co_filename}:{column}")
        return stages

    def comparison_outcomes(self, predicate: BoolPredicate, stages: dict[int, int],
                            previous: BoolDis.Instruction | None,
                            before_previous: BoolDis.Instruction | None) -> BoolPredicate:
        if not predicate.comparisons:
            return predicate
        if previous is not None and previous.opname == "COPY":
            if before_previous is None or before_previous.offset not in stages:
                raise AnalyzerError("Unmapped value-mode comparison test")
            return BoolPredicate((), ())
        if previous is None or previous.offset not in stages:
            raise AnalyzerError("Unmapped boolean-mode comparison test")
        yes = predicate.yes if stages[previous.offset] == predicate.comparisons - 1 else ()
        return BoolPredicate(yes, predicate.no)

    def bind_edges(self, code: CodeType, instruction: BoolDis.Instruction,
                   outcomes: BoolPredicate, edges: dict[tuple[int, int], tuple[int, ...]]) -> None:
        yes, no = outcomes.yes, outcomes.no
        if not (yes or no):
            return
        if instruction.opname not in {"POP_JUMP_IF_TRUE", "POP_JUMP_IF_FALSE"}:
            raise AnalyzerError(f"Unmapped BoolOp opcode: {instruction.opname}")
        target = instruction_value(instruction)
        if not isinstance(target, int):
            raise AnalyzerError("BoolOp jump has no integer destination")
        taken, fall = (yes, no) if instruction.opname.endswith("TRUE") else (no, yes)
        for destination, hits in ((target, taken), (instruction.offset + 2, fall)):
            key = (instruction.offset, destination)
            if key in edges and edges[key] != hits:
                raise AnalyzerError(f"Indistinguishable BoolOp outcomes: {code.co_filename}:{key}")
            edges[key] = hits

    def bind(self, code: CodeType, shadow: CodeType) -> BoolCode:
        instructions = list(BoolDis.get_instructions(shadow))
        stages = self.comparison_stages(code, instructions)
        edges: dict[tuple[int, int], tuple[int, ...]] = {}
        previous: BoolDis.Instruction | None = None
        before_previous: BoolDis.Instruction | None = None
        for instruction in instructions:
            if instruction.opname == "EXTENDED_ARG":
                continue
            positions = instruction.positions
            column = positions.col_offset if positions is not None else None
            predicate = self.tags.get(column) if column is not None else None
            if predicate is not None and instruction.opname.startswith("POP_JUMP_IF_"):
                outcomes = self.comparison_outcomes(predicate, stages, previous, before_previous)
                self.bind_edges(code, instruction, outcomes, edges)
            before_previous, previous = previous, instruction
        return BoolCode(code, edges, frozenset(offset for offset, _ in edges))


def BoolCompile(model: Model, branch_slots: dict[str, int],
                filename: str | None = None) -> BoolProgram:
    """Compile once after Instrument, preserving original Model map locations.

    Branch slot ``base`` is short-circuit; ``base + 1`` is continue. This mutates
    model.tree once, exactly like Instrument; use a fresh Model for recompilation.
    """
    check_pin()
    marker = BoolMarkers(model, branch_slots)
    tree = marker.visit(model.tree)
    assert isinstance(tree, ast.Module)
    _ = ast.fix_missing_locations(tree)
    shadow_tree, shadow_slots, shadow_leaves, shadow_ignored = BoolCopy.deepcopy(
        (tree, marker.slots, marker.leaves, marker.ignored)
    )
    locations = BoolShadow(shadow_slots, shadow_leaves, shadow_ignored)
    locations.continuations(shadow_tree)
    shadow_tree = locations.visit(shadow_tree)
    assert isinstance(shadow_tree, ast.Module)
    locations.locate(shadow_tree)
    path = filename if filename is not None else model.path
    actual = compile(tree, path, "exec", dont_inherit=True)
    shadow = compile(shadow_tree, path, "exec", dont_inherit=True)
    codes: dict[int, BoolCode] = {}

    def match(left: CodeType, right: CodeType) -> None:
        fields = (
            "co_code", "co_exceptiontable", "co_argcount", "co_posonlyargcount",
            "co_kwonlyargcount", "co_nlocals", "co_stacksize", "co_flags", "co_names",
            "co_varnames", "co_freevars", "co_cellvars", "co_name", "co_qualname",
            "co_filename", "co_firstlineno",
        )
        if any(getattr(left, field) != getattr(right, field) for field in fields):
            raise AnalyzerError(f"BoolOp shadow changes executable code: {path}:{left.co_qualname}")
        if len(left.co_consts) != len(right.co_consts):
            raise AnalyzerError("BoolOp shadow changes constant layout")
        for a, b in zip(code_constants(left), code_constants(right)):
            if isinstance(a, CodeType) and isinstance(b, CodeType):
                match(a, b)
            elif isinstance(a, CodeType) or isinstance(b, CodeType) or BoolMarshal.dumps(a) != BoolMarshal.dumps(b):
                raise AnalyzerError("BoolOp shadow changes constants")
        codes[id(left)] = locations.bind(left, right)

    match(actual, shadow)
    return BoolProgram(actual, codes, marker.helper)


class BoolRuntime:
    """One process-wide monitor; add programs before executing their code."""

    def __init__(self, hit: BoolCallable[[int], None], tool_id: int = 4) -> None:
        check_pin()
        self.hit: Callable[[int], None] = hit
        self.failure: Callable[[AnalyzerError], None] | None = None
        self.tool_id: int = tool_id
        self.codes: dict[int, BoolCode] = {}
        self.lock: threading.RLock = threading.RLock()
        self.closed: bool = False
        try:
            sys.monitoring.use_tool_id(tool_id, "d945-boolop")
        except ValueError as error:
            raise AnalyzerError(f"BoolOp monitoring tool {tool_id} unavailable") from error
        _ = sys.monitoring.register_callback(tool_id, sys.monitoring.events.BRANCH, self.branch)

    @staticmethod
    def marker(_identifier: int) -> None:
        """An opaque, non-raising leaf entry; never inspect an operand."""

    def add(self, program: BoolProgram) -> None:
        with self.lock:
            if self.closed:
                raise AnalyzerError("BoolOp monitor is closed")
            setattr(builtins, program.helper, self.marker)
            for identity, row in program.codes.items():
                self.codes[identity] = row
                if row.edges:
                    sys.monitoring.set_local_events(self.tool_id, row.code, sys.monitoring.events.BRANCH)

    def branch(self, code: CodeType, offset: int, destination: int) -> None:
        row = self.codes.get(id(code))
        if row is not None and offset in row.offsets:
            hits = row.edges.get((offset, destination))
            if hits is None:
                error = AnalyzerError(f"Unmapped BoolOp event: {code.co_filename}:{offset}->{destination}")
                if self.failure is not None:
                    self.failure(error)
                raise error
            for slot in hits:
                self.hit(slot)

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            for row in self.codes.values():
                if row.edges:
                    sys.monitoring.set_local_events(self.tool_id, row.code, 0)
            _ = sys.monitoring.register_callback(self.tool_id, sys.monitoring.events.BRANCH, None)
            sys.monitoring.free_tool_id(self.tool_id)
            self.closed = True


class Counters:
    """Mutable mmap accumulator; one lock serializes all thread increments."""

    def __init__(self, path: Path, slots: int) -> None:
        self.lock: threading.RLock = threading.RLock()
        self.slots: int = slots
        with path.open("xb") as output:
            _ = output.truncate(slots * 8)
        with path.open("r+b") as output:
            self.mapping: mmap.mmap | None = mmap.mmap(output.fileno(), slots * 8) if slots else None

    def hit(self, slot: int) -> None:
        assert self.mapping is not None
        with self.lock:
            previous, = struct.unpack_from("<d", self.mapping, slot * 8)
            if previous >= 2**53 - 1:
                raise AnalyzerError("Counter exceeds exact integer range")
            struct.pack_into("<d", self.mapping, slot * 8, previous + 1)

    def flush(self) -> None:
        if self.mapping is not None:
            self.mapping.flush()


class ArcSet(set[tuple[int, int]]):
    """PyTracer's native add events persisted before control returns to target."""

    def __init__(self, model: Model, counters: Counters, line_offset: int,
                 branch_slots: dict[str, int]) -> None:
        super().__init__()
        self.parser: PythonParser = model.parser
        self.counters: Counters = counters
        self.line_slots: dict[int, int] = {line: line_offset + index for index, line in enumerate(model.prepared["lines"])}
        self.arc_slots: dict[tuple[int, int], int] = {
            (row["line"], target): branch_slots[row["id"]] + index
            for row in model.prepared["arcs"] for index, target in enumerate(row["targets"])
        }

    @override
    def add(self, arc: tuple[int, int]) -> None:
        with self.counters.lock:
            super().add(arc)
            if arc[1] > 0:
                line_slot = self.line_slots.get(self.parser.first_line(arc[1]))
                if line_slot is not None:
                    self.counters.hit(line_slot)
            for translated in self.parser.translate_arcs({arc}):
                slot = self.arc_slots.get(translated)
                if slot is not None:
                    self.counters.hit(slot)


@dataclass(frozen=True, slots=True)
class OwnedFile:
    model: Model
    slots: dict[tuple[str, str], int]
    branch_slots: dict[str, int]
    line_offset: int


def manifest_counters(model: Model, offset: int, line_offset: int,
                      occupied: set[int], slots: int) -> OwnedFile:
    entry_slots: dict[tuple[str, str], int] = {}
    branch_slots: dict[str, int] = {}
    cov = model.prepared["coverage"]
    start = offset
    for dimension in ("s", "f"):
        for key in cov[dimension]:
            entry_slots[dimension, key] = offset
            offset += 1
    for key, zeros in cov["b"].items():
        branch_slots[key] = offset
        offset += len(zeros)
    claimed = list(range(start, offset)) + list(range(line_offset, line_offset + len(model.prepared["lines"])))
    if len(set(claimed)) != len(claimed) or occupied.intersection(claimed) or any(index >= slots for index in claimed):
        raise AnalyzerError("Overlapping or out-of-bounds Python counters")
    occupied.update(claimed)
    return OwnedFile(model, entry_slots, branch_slots, line_offset)


class OwnedLoader(importlib.abc.InspectLoader):
    def __init__(self, owner: Runner, row: OwnedFile) -> None:
        self.owner: Runner = owner
        self.row: OwnedFile = row

    @override
    def get_source(self, fullname: str) -> str:
        return self.row.model.source

    def get_filename(self, _fullname: str) -> str:
        return self.owner.filename(self.row)

    @override
    def is_package(self, fullname: str) -> bool:
        return Path(self.row.model.path).name == "__init__.py"

    @override
    def get_code(self, fullname: str) -> CodeType:
        return self.owner.compile(self.row)

    @override
    def exec_module(self, module: ModuleType) -> None:
        exec(self.get_code(module.__name__), module.__dict__)


class OwnedFinder(importlib.abc.MetaPathFinder):
    def __init__(self, owner: Runner) -> None:
        self.owner: Runner = owner

    @override
    def find_spec(self, fullname: str, path: Iterable[str] | None = None,
                  target: ModuleType | None = None) -> importlib.machinery.ModuleSpec | None:
        leaf = fullname.rsplit(".", 1)[-1]
        folders = list(sys.path if path is None else path)
        for folder in folders:
            native = importlib.machinery.PathFinder.find_spec(fullname, [folder], target)
            if native is not None and native.loader is not None:
                if native.origin is not None:
                    row = self.owner.by_filename.get(canonical_filename(native.origin))
                    if row is not None:
                        native.loader = OwnedLoader(self.owner, row)
                return native
            for suffix in (f"{leaf}/__init__.py", f"{leaf}.py"):
                candidate = canonical_filename(os.path.join(folder, suffix))
                row = self.owner.by_filename.get(candidate)
                if row is None:
                    continue
                return importlib.util.spec_from_file_location(
                    fullname, candidate, loader=OwnedLoader(self.owner, row),
                    submodule_search_locations=[str(Path(candidate).parent)]
                    if suffix.endswith("/__init__.py") else None,
                )
        return None


class TracedCoverage(coverage.Coverage):
    """Install the native tracer's per-file arc sets after collector startup."""

    def install_arcs(self, arcs: dict[str, ArcSet]) -> None:
        assert self._collector is not None
        self._collector.data.update(arcs)


def native_run_path(read: Callable[[ModuleType, str], Callable[[str], CodeType]] = getattr) -> Callable[[str], CodeType]:
    """The pinned runpy private code loader has this one-argument contract."""
    return read(runpy, "_get_code_from_file")


class Runner:
    """Own a single process receipt and its manifest-selected source transforms."""

    def __init__(self, directory: Path, identifier: str, entry: str) -> None:
        self.directory: Path = directory
        self.identifier: str = identifier
        self.entry: str = entry
        self.loaded: set[str] = set()
        self.compiled: dict[int, tuple[CodeType, OwnedFile]] = {}
        self.receipt_lock: threading.RLock = threading.RLock()
        self.active: bool = False
        self.finished: bool = False
        self.rows: dict[str, OwnedFile] = {}
        self.by_filename: dict[str, OwnedFile] = {}
        self.arc_sets: dict[str, ArcSet] = {}
        self.receipt("start", {
            "id": identifier, "parent": os.environ.get("D945_PARENT"),
            "pid": os.getpid(), "runtime": "python", "entry": entry,
        })
        self.receipt("children", [])
        self.receipt("loaded", [])
        size = json_object(decode_json((directory / "process-size.json").read_text()))
        slots = json_integer(size["slots"])
        if slots < 0:
            raise AnalyzerError("Invalid process slot count")
        self.counters: Counters = Counters(directory / f"{identifier}.counts.bin", slots)
        manifest = json_array(decode_json((directory / "python-files.json").read_text()))
        occupied: set[int] = set()
        for value in manifest:
            raw = json_object(value)
            model = Model(json_string(raw["path"]), json_string(raw["source"]))
            for field in ("coverage", "lines", "arcs"):
                if raw[field] != model.prepared[field]:
                    raise AnalyzerError(f"Stale Python {field}: {model.path}")
            offset = json_integer(raw["offset"])
            line_offset = json_integer(raw["lineOffset"])
            if offset < 0 or line_offset < 0:
                raise AnalyzerError("Invalid Python counter offset")
            row = manifest_counters(model, offset, line_offset, occupied, slots)
            canonical = canonical_filename(self.filename(row))
            if model.path in self.rows or canonical in self.by_filename:
                raise AnalyzerError(f"Duplicate Python source identity: {model.path}")
            self.rows[model.path] = row
            self.by_filename[canonical] = row
            self.arc_sets[canonical] = ArcSet(model, self.counters, line_offset, row.branch_slots)
        if entry not in self.rows:
            raise AnalyzerError(f"Entry absent from manifest: {entry}")
        self.cov: TracedCoverage = TracedCoverage(
            branch=True, timid=True, concurrency=["thread"], config_file=False,
            data_file=str(directory / f"{identifier}.coverage"),
            include=list(self.by_filename),
        )
        self.cov.set_option("report:exclude_lines", [])
        self.cov.set_option("report:partial_branches", [])
        self.cov.set_option("report:partial_branches_always", [])
        self.bools: BoolRuntime = BoolRuntime(self.hit)
        self.bools.failure = self.fail

    def receipt(self, kind: str, value: JsonValue) -> None:
        with self.receipt_lock:
            destination = self.directory / f"{self.identifier}.{kind}.json"
            temporary = destination.with_suffix(".tmp")
            _ = temporary.write_text(json.dumps(value, sort_keys=True))
            _ = temporary.replace(destination)

    def filename(self, row: OwnedFile) -> str:
        return row.model.path if "#" in row.model.path else os.path.abspath(row.model.path)

    def fail(self, error: BaseException) -> None:
        self.receipt("failure", {"error": str(error), "type": type(error).__name__})

    def hit(self, slot: int) -> None:
        try:
            self.counters.hit(slot)
        except Exception as error:
            self.fail(error)
            raise

    def compile(self, row: OwnedFile) -> CodeType:
        try:
            model = Model(row.model.path, row.model.source)
            tree = Instrument(model, row.slots).visit(model.tree)
            assert isinstance(tree, ast.Module)
            _ = ast.fix_missing_locations(tree)
            filename = self.filename(row)
            program = BoolCompile(model, row.branch_slots, filename)
            self.bools.add(program)
            code = program.code
            setattr(builtins, model.helper, self.hit)
            linecache.cache[filename] = (len(model.source), None, model.source.splitlines(True), filename)
            self.compiled[id(code)] = (code, row)
            return code
        except Exception as error:
            self.fail(error)
            raise

    def audit(self, event: str, arguments: tuple[AuditArgument, ...]) -> None:
        if self.active and event in PROCESS_EVENTS:
            error = AnalyzerError(f"Unobservable Python process context: {event}")
            self.fail(error)
            raise error
        if self.active and event == "exec":
            code = arguments[0]
            assert isinstance(code, CodeType)
            owned = self.compiled.get(id(code))
            if owned is not None:
                _, row = owned
                with self.receipt_lock:
                    self.loaded.add(row.model.path)
                    self.receipt("loaded", sorted(self.loaded))
                for node in row.model.statements:
                    if isinstance(node, ast.ImportFrom) and node.module == "__future__":
                        self.counters.hit(row.slots["s", row.model.sids[node]])
            elif canonical_filename(code.co_filename) in self.by_filename:
                error = AnalyzerError(f"Uninstrumented execution of owned source: {code.co_filename}")
                self.fail(error)
                raise error

    def finish(self) -> None:
        if self.finished:
            return
        self.finished = True
        try:
            self.active = False
            self.cov.stop()
            self.bools.close()
            self.counters.flush()
            # get_data flushes the native collector; snapshot sets before that.
            traces = {
                self.by_filename[path].model.path: {
                    "arcs": sorted(data),
                    "translatedArcs": sorted(data.parser.translate_arcs(data)),
                } for path, data in self.arc_sets.items()
            }
            self.cov.save()
            self.receipt("trace", {
                "id": self.identifier, "runtime": "python",
                "python": PIN[0], "coverage": PIN[1], "flushed": True,
                "files": traces,
            })
        except Exception as error:
            self.fail(error)
            raise

    def run(self, arguments: list[str]) -> None:
        entry = self.rows[self.entry]
        self.cov.start()
        self.cov.install_arcs(self.arc_sets)
        finder = OwnedFinder(self)
        sys.meta_path.insert(sys.meta_path.index(importlib.machinery.PathFinder), finder)
        original_get_code = importlib.machinery.SourceFileLoader.get_code
        owner = self

        def get_code(self: importlib.machinery.SourceFileLoader, fullname: str) -> CodeType | None:
            row = owner.by_filename.get(canonical_filename(self.path))
            if row is not None:
                return owner.compile(row)
            return original_get_code(self, fullname)

        importlib.machinery.SourceFileLoader.get_code = get_code
        # This pinned private API is absent from typeshed's public runpy stub.
        original_run_path_code = native_run_path()

        def run_path_code(fname: str) -> CodeType:
            row = self.by_filename.get(canonical_filename(fname))
            if row is not None:
                return self.compile(row)
            return original_run_path_code(fname)

        runpy.__dict__["_get_code_from_file"] = run_path_code
        sys.addaudithook(self.audit)
        _ = atexit.register(self.finish)
        self.active = True
        filename = self.filename(entry)
        sys.argv = [filename, *arguments]
        sys.path[0] = os.path.dirname(os.path.abspath(filename))
        main = ModuleType("__main__")
        main.__file__ = filename
        vars(main)["__package__"] = None
        main.__spec__ = None
        main.__loader__ = OwnedLoader(self, entry)
        sys.modules["__main__"] = main
        exec(self.compile(entry), main.__dict__)
        # Native shutdown joins non-daemon threads before our atexit flush.


def main() -> None:
    check_pin()
    match sys.argv[1:]:
        case ["prepare"]:
            raw = json_object(decode_json(sys.stdin.read()))
            path, source = raw.get("path"), raw.get("source")
            if not isinstance(path, str) or not isinstance(source, str):
                raise AnalyzerError("prepare requires {path: string, source: string}")
            model = Model(path, source)
            print(json.dumps(model.prepared))
        case ["verify-trace"]:
            trace = decode_trace(decode_json(sys.stdin.read()))
            Model(trace["path"], trace["source"]).verify_trace(trace)
            print(json.dumps({"valid": True}))
        case ["run", directory, identifier, entry, *arguments]:
            if not re.fullmatch(r"[A-Za-z0-9_-]+", identifier):
                raise AnalyzerError("Invalid process identifier")
            try:
                runner = Runner(Path(directory), identifier, entry)
            except Exception as error:
                _ = (Path(directory) / f"{identifier}.failure.json").write_text(json.dumps({
                    "error": str(error), "type": type(error).__name__,
                }))
                raise
            try:
                runner.run(arguments)
            except AnalyzerError as error:
                runner.fail(error)
                raise
        case _:
            raise AnalyzerError("Usage: python.py prepare | run <directory> <id> <path> [args...]")


if __name__ == "__main__":
    main()
