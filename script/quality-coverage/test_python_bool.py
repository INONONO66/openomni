"""Exact native BoolOp counters; run with pinned CPython, without pytest."""

from __future__ import annotations

import ast
import builtins
import copy
import dis
import inspect
import itertools
import struct
import sys
import tempfile
import threading
import unittest
from collections.abc import Buffer, Callable, Coroutine, Generator, Iterable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from types import CodeType, FunctionType
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from . import python as ADAPTER
else:
    import python as ADAPTER


class Identity:
    """An opaque operand whose identity must survive native truth evaluation."""


class Suspension:
    def __init__(self, tag: str, result: FixtureValue) -> None:
        self.tag: str = tag
        self.result: FixtureValue = result

    def __await__(self) -> Generator[FixtureValue, FixtureValue, FixtureValue]:
        yield self.tag
        return self.result


type FixtureValue = None | bool | int | str | Bit | Identity | Sequence[FixtureValue] | Suspension | Generator[FixtureValue, FixtureValue, FixtureValue] | Coroutine[FixtureValue, FixtureValue, FixtureValue]


class FixtureFunction(Protocol):
    @property
    def __code__(self) -> CodeType: ...

    __annotations__: dict[str, ADAPTER.AuditArgument]

    def __call__(self, *args: FixtureValue, **kwargs: FixtureValue) -> FixtureValue: ...


class StoppedValue(Protocol):
    @property
    def value(self) -> FixtureValue: ...


def stopped_value(error: StoppedValue) -> FixtureValue:
    return error.value


def execute_functions(code: CodeType) -> dict[str, FixtureFunction]:
    namespace: dict[str, ADAPTER.AuditArgument] = {}
    exec(code, namespace)
    functions: dict[str, FixtureFunction] = {}
    for name, value in namespace.items():
        if isinstance(value, FunctionType):
            functions[name] = value
    return functions


def double_at(buffer: Buffer, offset: int,
              unpack: Callable[[str, Buffer, int], tuple[float]] = struct.unpack_from) -> float:
    return unpack("<d", buffer, offset)[0]


class Measured:
    """Use the real Model, entry transform, mmap counters and monitoring API."""

    def __init__(self, source: str, directory: str) -> None:
        self.model: ADAPTER.Model = ADAPTER.Model("bool-fixture.py", source)
        self.original_maps: ADAPTER.Prepared = copy.deepcopy(self.model.prepared)
        self.branch_ids: list[str] = list(self.model.bids.values())
        slots: dict[tuple[str, str], int] = {}
        offset = 0
        for dimension in ("s", "f"):
            for key in self.model.prepared["coverage"][dimension]:
                slots[dimension, key] = offset
                offset += 1
        self.branch_slots: dict[str, int] = {}
        for key, zeros in self.model.prepared["coverage"]["b"].items():
            self.branch_slots[key] = offset
            offset += len(zeros)
        self.counters: ADAPTER.Counters = ADAPTER.Counters(Path(directory) / "counts.bin", offset)
        tree = ADAPTER.Instrument(self.model, slots).visit(self.model.tree)
        assert isinstance(tree, ast.Module)
        self.model.tree = tree
        self.program: ADAPTER.BoolProgram = ADAPTER.BoolCompile(self.model, self.branch_slots)
        setattr(builtins, self.model.helper, self.counters.hit)
        self.runtime: ADAPTER.BoolRuntime = ADAPTER.BoolRuntime(self.counters.hit)
        self.runtime.add(self.program)
        self.namespace: dict[str, FixtureFunction] = execute_functions(self.program.code)

    def hits(self) -> list[list[int]]:
        mapping = self.counters.mapping
        assert mapping is not None
        return [
            [int(double_at(mapping, (self.branch_slots[key] + i) * 8))
             for i in range(2)]
            for key in self.branch_ids
        ]

    def close(self) -> None:
        self.runtime.close()
        self.counters.flush()
        if self.counters.mapping is not None:
            self.counters.mapping.close()


@contextmanager
def measured(source: str) -> Generator[Measured]:
    with tempfile.TemporaryDirectory() as directory:
        case = Measured(source, directory)
        try:
            yield case
        finally:
            case.close()


type BitEvent = tuple[str, bool | BaseException] | tuple[str, str, str]


class Bit:
    def __init__(self, name: str, answers: Iterable[bool | BaseException],
                 log: list[BitEvent]) -> None:
        self.name: str = name
        self.answers: Iterator[bool | BaseException] = iter(answers)
        self.log: list[BitEvent] = log

    def __bool__(self) -> bool:
        answer = next(self.answers)
        self.log.append((self.name, answer))
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def __lt__(self, other: Bit) -> Bit:
        self.log.append(("compare", self.name, other.name))
        return self


class BoolTests(unittest.TestCase):
    def test_flat_same_line_and_original_ranges(self) -> None:
        source = "def f(a,b,c): return (a and b and c), (a or b or c)\n"
        with measured(source) as case:
            for values in itertools.product((False, True), repeat=3):
                self.assertEqual(case.namespace["f"](*values),
                                 ((values[0] and values[1] and values[2]),
                                  (values[0] or values[1] or values[2])))
            self.assertEqual(case.hits(), [[4, 4], [2, 2], [4, 4], [2, 2]])
            self.assertEqual(case.model.prepared, case.original_maps)
            self.assertEqual(len(case.original_maps["coverage"]["branchMap"]), 4)

    def test_nested_boolean_context_multi_counter_edges(self) -> None:
        for expression, expected in (
            ("(a and b) or c", [[2, 6], [4, 4]]),
            ("(a or b) and c", [[2, 6], [4, 4]]),
            ("not (a and b) or c", [[6, 2], [4, 4]]),
            ("(a and b) and c", [[6, 2], [4, 4]]),
        ):
            with (self.subTest(expression=expression),
                  measured(f"def f(a,b,c):\n if {expression}: return 1\n return 0\n") as case):
                for values in itertools.product((False, True), repeat=3):
                    _ = case.namespace["f"](*values)
                self.assertEqual(case.hits(), expected)
                self.assertTrue(any(len(hits) > 1 for row in case.program.codes.values()
                                    for hits in row.edges.values()))

    def test_value_mode_retests_side_effectful_operand(self) -> None:
        with measured("def f(a,b,c): return (a and b) or c\n") as case:
            log: list[BitEvent] = []
            a = Bit("a", [False, True], log)
            b, c = Identity(), Identity()
            self.assertIs(case.namespace["f"](a, b, c), a)
            self.assertEqual(log, [("a", False), ("a", True)])
            self.assertEqual(case.hits(), [[1, 0], [1, 0]])
        with measured("def f(a,b,c):\n if (a and b) or c: return 1\n return 0\n") as case:
            log = []
            a = Bit("a", [False, True], log)
            c = Bit("c", [False], log)
            self.assertEqual(case.namespace["f"](a, Identity(), c), 0)
            self.assertEqual(log, [("a", False), ("c", False)])
            self.assertEqual(case.hits(), [[0, 1], [1, 0]])

    def test_not_and_chained_comparison_do_not_add_truth_tests(self) -> None:
        for statement, expected in (
            ("if not (a and b) or c: return 1", [[1, 0], [1, 0]]),
            ("if (a < b < c) or d: return 1", [[0, 1]]),
            ("return (a < b < c) or d", [[1, 0]]),
        ):
            with self.subTest(statement=statement):
                source = f"def f(a,b,c,d):\n {statement}\n return 0\n"
                original = execute_functions(compile(source, "bool-fixture.py", "exec"))
                outputs: list[tuple[FixtureValue, list[BitEvent]]] = []
                with measured(source) as case:
                    for function in (original["f"], case.namespace["f"]):
                        log: list[BitEvent] = []
                        args = [Bit(name, [False, True, False], log) for name in "abcd"]
                        result = function(*args)
                        outputs.append((result.name if isinstance(result, Bit) else result, log))
                    self.assertEqual(outputs[0], outputs[1])
                    self.assertEqual(case.hits(), expected)

    def test_comparison_chain_all_stages_and_conditional_arms(self) -> None:
        source = "def f(a,b,c,d,q):\n if ((a < b < c) if q else (a is b is c)) or d: return 1\n return 0\n"
        with measured(source) as case:
            f = case.namespace["f"]
            # Each comparison chain: first false, last false, all true.
            for args in ((2, 1, 3, False, True), (1, 3, 2, False, True),
                         (1, 2, 3, False, True), (1, 2, 2, False, False),
                         (1, 1, 2, False, False), (1, 1, 1, False, False)):
                _ = f(*args)
            self.assertEqual(case.hits(), [[2, 4]])

    def test_constants_are_observable_and_dead_code_stays_zero(self) -> None:
        source = '''
def f(a):
 if a or True: pass
 if a and False: pass
 value = True and a
 other = False or a
 if False:
  never = a and a
 return value, other
'''
        with measured(source) as case:
            self.assertEqual(case.namespace["f"](False), (False, False))
            self.assertEqual(case.namespace["f"](True), (True, True))
            self.assertEqual(case.hits(), [[1, 1], [1, 1], [0, 2], [0, 2], [0, 0]])

    def test_duplicated_while_and_finally_conditions(self) -> None:
        source = '''
def loop(a,b,c):
 while a < b < c and b:
  a += 1
 return a
def final(a,b,c):
 try:
  if a: return 1
  raise ValueError()
 finally:
  if a < b < c or b: pass
'''
        with measured(source) as case:
            self.assertEqual(case.namespace["loop"](0, 2, 3), 2)
            self.assertEqual(case.namespace["final"](1, 2, 3), 1)
            with self.assertRaises(ValueError):
                _ = case.namespace["final"](0, 0, 1)
            self.assertEqual(case.hits(), [[1, 2], [1, 1]])

    def test_generators_and_coroutines_preserve_suspension_and_identity(self) -> None:
        source = '''
def gen(a, /, *, b=7):
 return (yield a) and (yield b)
async def coro(a, /, *, b=7):
 return (await a) or (await b)
'''
        with measured(source) as case:
            gen, coro = case.namespace["gen"], case.namespace["coro"]
            self.assertTrue(inspect.isgeneratorfunction(gen))
            self.assertTrue(inspect.iscoroutinefunction(coro))
            self.assertEqual(str(inspect.signature(gen)), "(a, /, *, b=7)")
            first, second = gen("a"), gen("x")
            assert isinstance(first, Generator) and isinstance(second, Generator)
            self.assertEqual(next(first), "a")
            self.assertEqual(next(second), "x")
            self.assertEqual(case.hits(), [[0, 0], [0, 0]])
            with self.assertRaises(StopIteration) as end:
                _ = second.send(False)
            self.assertIs(stopped_value(end.exception), False)
            self.assertEqual(first.send(True), 7)
            token = Identity()
            with self.assertRaises(StopIteration) as end:
                _ = first.send(token)
            self.assertIs(stopped_value(end.exception), token)
            for truth in (False, True):
                current = coro(Suspension("a", truth), b=Suspension("b", token))
                assert isinstance(current, Coroutine)
                self.assertEqual(current.send(None), "a")
                if not truth:
                    self.assertEqual(current.send(None), "b")
                with self.assertRaises(StopIteration) as end:
                    _ = current.send(None)
                self.assertIs(stopped_value(end.exception), True if truth else token)
            self.assertEqual(case.hits(), [[1, 1], [1, 1]])

    def test_raising_truth_and_throw_do_not_credit_unfinished_decisions(self) -> None:
        source = '''
def f(a,b): return a and b
def gen(): return (yield 1) or 2
'''
        with measured(source) as case:
            log: list[BitEvent] = []
            with self.assertRaisesRegex(ValueError, "truth"):
                _ = case.namespace["f"](Bit("a", [ValueError("truth")], log), Identity())
            generator = case.namespace["gen"]()
            assert isinstance(generator, Generator)
            self.assertEqual(next(generator), 1)
            with self.assertRaises(KeyError):
                _ = generator.throw(KeyError("throw"))
            self.assertEqual(case.hits(), [[0, 0], [0, 0]])
            self.assertEqual(len(log), 1)

    def test_comprehension_lambda_named_expression_and_match_guard(self) -> None:
        source = '''
def f(values):
 out = [a and b for a,b in values if a or b]
 fn = lambda a,b: (saved := a) or b
 for a,b in values:
  match a:
   case _ if a and b: fn(a,b)
 return out
'''
        with measured(source) as case:
            self.assertEqual(case.namespace["f"]([(False, False), (False, True),
                                                  (True, False), (True, True)]),
                             [False, False, True])
            self.assertEqual(case.hits(), [[1, 2], [2, 2], [1, 0], [2, 2]])

    def test_future_annotations_and_unrelated_none_tests_are_untouched(self) -> None:
        source = '''
from __future__ import annotations
def f(a: int or str, b: list[int and str]) -> int or str:
 if a is None: return b
 return a or b
x: int and str
'''
        original = execute_functions(compile(source, "bool-fixture.py", "exec"))
        with measured(source) as case:
            f = case.namespace["f"]
            self.assertEqual(f.__annotations__, original["f"].__annotations__)
            self.assertEqual(str(inspect.signature(f)), str(inspect.signature(original["f"])))
            self.assertEqual(len(case.branch_ids), 1)
            self.assertEqual(f(None, 3), 3)
            self.assertEqual(f(False, 3), 3)
            self.assertEqual(f(True, 3), True)
            self.assertEqual(case.hits(), [[1, 1]])

    def test_threaded_exact_mmap_counts(self) -> None:
        source = "def f(a,b): return a and b\n"
        with measured(source) as case:
            barrier = threading.Barrier(5)

            def worker() -> None:
                _ = barrier.wait(timeout=10)
                for index in range(100):
                    _ = case.namespace["f"](index % 2 == 0, True)

            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = [executor.submit(worker) for _ in range(4)]
                _ = barrier.wait(timeout=10)
                for future in futures:
                    future.result(timeout=10)
            self.assertEqual(case.hits(), [[200, 200]])

    def test_identical_code_objects_have_independent_slot_bindings(self) -> None:
        source = "def f(a,b): return a and b\n"
        models = [ADAPTER.Model("identical.py", source) for _ in range(2)]
        programs = [ADAPTER.BoolCompile(model, {next(iter(model.bids.values())): index * 2})
                    for index, model in enumerate(models)]
        with tempfile.TemporaryDirectory() as directory:
            counters = ADAPTER.Counters(Path(directory) / "counts.bin", 4)
            runtime = ADAPTER.BoolRuntime(counters.hit)
            try:
                namespaces: list[dict[str, FixtureFunction]] = []
                for program in programs:
                    runtime.add(program)
                    namespace = execute_functions(program.code)
                    namespaces.append(namespace)
                # CodeType equality is structural; the registry must use identity.
                a, b = [namespace["f"] for namespace in namespaces]
                self.assertEqual(a.__code__, b.__code__)
                self.assertIsNot(a.__code__, b.__code__)
                _ = a(False, True)
                _ = b(True, False)
                assert counters.mapping is not None
                self.assertEqual(struct.unpack("<4d", counters.mapping), (1, 0, 0, 1))
            finally:
                runtime.close()
                assert counters.mapping is not None
                counters.mapping.close()

    def test_extended_arguments_and_bytecode_identity_guard(self) -> None:
        expression = " or ".join(f"a[{index}]" for index in range(150))
        with measured(f"def f(a): return {expression}\n") as case:
            self.assertTrue(any(instruction.opname == "EXTENDED_ARG"
                                for row in case.program.codes.values()
                                for instruction in dis.get_instructions(row.code)))
            self.assertFalse(case.namespace["f"]([False] * 150))
            self.assertEqual(case.hits(), [[0, 1]] * 149)

    def test_unmapped_runtime_destination_is_an_analysis_error(self) -> None:
        with measured("def f(a,b): return a and b\n") as case:
            failures: list[ADAPTER.AnalyzerError] = []
            case.runtime.failure = failures.append
            function = case.namespace["f"]
            row = case.program.codes[id(function.__code__)]
            offset = next(iter(row.offsets))
            # Corrupt a compiled map, then execute the actual monitored function.
            # The monitor must not silently turn a missing edge into zero hits.
            row.edges.clear()
            with self.assertRaises(ADAPTER.AnalyzerError):
                _ = function(True, False)
            self.assertEqual(case.hits(), [[0, 0]])
            self.assertIn(offset, row.offsets)
            self.assertEqual(len(failures), 1)
            self.assertIsInstance(failures[0], ADAPTER.AnalyzerError)

    def test_analysis_rejects_indistinguishable_edges_and_tool_collision(self) -> None:
        # Exercise the real binder against the previously ambiguous native code,
        # not a mock of monitoring or its truth result.
        tree = ast.parse("def f(a):\n if a or True: pass\n return 3\n")
        name = next(node for node in ast.walk(tree) if isinstance(node, ast.Name))
        shadow = ADAPTER.BoolShadow({}, set(), set())
        shadow.predicates[name] = ADAPTER.BoolPredicate((0,), (1,))
        shadow.locate(tree)
        code = ADAPTER.code_constants(compile(tree, "ambiguous.py", "exec"))[0]
        assert isinstance(code, CodeType)
        with self.assertRaises(ADAPTER.AnalyzerError):
            _ = shadow.bind(code, code)
        sys.monitoring.use_tool_id(4, "occupied-by-test")
        try:
            with self.assertRaises(ADAPTER.AnalyzerError):
                _ = ADAPTER.BoolRuntime(lambda slot: None)
        finally:
            sys.monitoring.free_tool_id(4)


if __name__ == "__main__":
    ADAPTER.check_pin()
    _ = unittest.main(verbosity=2)
