"""Native annotation evaluation and original-source function census oracles."""

from __future__ import annotations

import ast
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .test_python import CountResult, ManifestRow, execute_native
else:
    from test_python import CountResult, ManifestRow, execute_native


def annotation_counts(row: ManifestRow, hits: CountResult, functions: int, branches: int) -> None:
    assert len(row["coverage"]["fnMap"]) == functions
    assert list(hits["f"].values()) == [1] * functions
    binary = [key for key, branch in row["coverage"]["branchMap"].items()
              if branch["type"] == "binary-expr"]
    assert len(binary) == branches
    assert [hits["b"][key] for key in binary] == [[0, 1]] * branches


def test_module_and_class_annotations_when_unassigned_expressions_execute() -> None:
    source = '''
effects = []
x: (lambda: effects.append("module-unassigned") or int)()
y: (lambda: effects.append("module-assigned") or str)() = "value"
class C:
    x: (lambda: effects.append("class-unassigned") or int)()
    y: (lambda: effects.append("class-assigned") or str)() = "value"
print(effects)
print(__annotations__["x"].__name__, C.__annotations__["y"].__name__)
'''
    row, hits = execute_native(source)
    annotation_counts(row, hits, 4, 4)
    type_only = {node.lineno for node in ast.walk(ast.parse(source))
                 if isinstance(node, ast.AnnAssign) and node.value is None}
    assert not type_only.intersection(
        location["start"]["line"] for location in row["coverage"]["statementMap"].values()
    )


def test_local_annotations_when_nested_scopes_change_evaluation() -> None:
    source = '''
import asyncio
effects = []
def outer():
    x: (lambda: effects.append("never-local") or int)() = 1
    if x:
        y: (lambda: effects.append("never-unassigned") or int)()
    class C:
        x: (lambda: effects.append("nested-class") or int)()
        def method(self):
            x: (lambda: effects.append("never-method") or int)() = 2
            return x
    def inner(arg: (lambda: effects.append("parameter") or int)()):
        x: (lambda: effects.append("never-inner") or int)() = arg
        return x
    return inner(C().method())
async def coroutine():
    x: (lambda: effects.append("never-async") or int)() = 3
    return x
print(outer(), asyncio.run(coroutine()), effects)
'''
    row, hits = execute_native(source)
    annotation_counts(row, hits, 6, 2)


def test_nonsimple_annotations_when_only_targets_execute() -> None:
    source = '''
effects = []
class C:
    pass
holder = C()
(lambda: effects.append("attribute-target") or holder)().value: (lambda: 1 or 2)()
(lambda: effects.append("subscript-target") or {})()[(lambda: effects.append("index") or 0)()]: (lambda: 1 or 2)()
(parenthesized): (lambda: 1 or 2)()
def function():
    (lambda: effects.append("local-target") or holder)().value: (lambda: 1 or 2)()
function()
print(effects)
'''
    row, hits = execute_native(source)
    annotation_counts(row, hits, 5, 4)


def test_future_annotations_when_strings_and_assignment_values_are_preserved() -> None:
    source = '''
from __future__ import annotations
import inspect
x: (lambda: 1) or int
class C:
    x: (lambda: 2) or str
    y: (lambda: 3) or int = (lambda: 4)()
def function(a: (lambda: 5) or int) -> (lambda: 6) or str:
    return a
print(__annotations__, C.__annotations__, function.__annotations__)
print(inspect.signature(function), function(C.y))
'''
    row, hits = execute_native(source)
    assert len(row["coverage"]["fnMap"]) == 2
    assert list(hits["f"].values()) == [1, 1]
    assert not any(branch["type"] == "binary-expr"
                   for branch in row["coverage"]["branchMap"].values())


def test_lazy_type_parameters_when_bounds_and_aliases_stay_type_only() -> None:
    source = '''
effects = []
def function[T: (lambda: effects.append("function-bound") or int)]():
    value: (lambda: 1 or 2) = 1
    return value
class C[T: (lambda: effects.append("class-bound") or str)]:
    pass
type Alias = (lambda: effects.append("alias") or int)()
print(function(), effects)
print(function.__type_params__[0].__bound__().__name__)
print(C.__type_params__[0].__bound__().__name__, Alias.__value__.__name__, effects)
'''
    row, hits = execute_native(source)
    assert len(row["coverage"]["fnMap"]) == 1
    assert hits["f"] == {"0": 1}
    assert not any(branch["type"] == "binary-expr"
                   for branch in row["coverage"]["branchMap"].values())


if __name__ == "__main__":
    tests = [
        test_module_and_class_annotations_when_unassigned_expressions_execute,
        test_local_annotations_when_nested_scopes_change_evaluation,
        test_nonsimple_annotations_when_only_targets_execute,
        test_future_annotations_when_strings_and_assignment_values_are_preserved,
        test_lazy_type_parameters_when_bounds_and_aliases_stay_type_only,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
