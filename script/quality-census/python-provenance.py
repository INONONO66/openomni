"""Python AST boundary analysis for canonical-inventory sources (no filesystem scan)."""
import ast
import json
import sys
from collections.abc import Callable
from typing import TextIO, TypeGuard, TypedDict

class Source(TypedDict):
    text: str
    path: str
    operational: bool

class Input(TypedDict):
    sources: list[Source]

class Boundary(TypedDict, total=False):
    line: int
    symbol: str
    kind: str
    family: str
    sql: str
    read: bool
    write: bool
    forwardingLines: list[int]

class Problem(TypedDict):
    line: int
    symbol: str
    code: str

class Analysis(TypedDict):
    path: str
    complete: bool
    boundaries: list[Boundary]
    errors: list[Problem]
    externalCode: list[Boundary]
    reachableFunctions: list[str]

class Report(TypedDict):
    version: int
    python: str
    sources: list[Analysis]

def object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def load_input(reader: Callable[[TextIO], Input]) -> Input:
    return reader(sys.stdin)


def analyze(source: str, path: str, operational: bool) -> Analysis:
    tree = ast.parse(source, filename=path)
    parents: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
    def scope(node: ast.AST) -> ast.AST | None:
        parent = parents.get(node)
        while parent is not None and not isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.Module)):
            parent = parents.get(parent)
        return parent
    def after_terminal(parent: ast.AST, child: ast.AST) -> bool:
        for field in ('body', 'orelse', 'finalbody'):
            statements = getattr(parent, field, [])
            if object_list(statements) and child in statements:
                if any(isinstance(statement, (ast.Return, ast.Raise, ast.Break, ast.Continue)) for statement in statements[:statements.index(child)]):
                    return True
        return False
    def active(node: ast.AST) -> bool:
        child = node
        parent = parents.get(node)
        while parent is not None and not isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            if isinstance(parent, (ast.If, ast.While)) and isinstance(parent.test, ast.Constant):
                if child in parent.body and not parent.test.value:
                    return False
                if child in parent.orelse and parent.test.value and isinstance(parent, ast.If):
                    return False
            if after_terminal(parent, child):
                return False
            child, parent = parent, parents.get(parent)
        return True
    bindings: dict[tuple[ast.AST | None, str], ast.AST | str | None] = {}
    parameters: dict[ast.arg, ast.expr] = {}
    def bind(node: ast.AST, identifier: str, value: ast.AST | str | None) -> None:
        bindings[(scope(node), identifier)] = value
    def lookup(node: ast.AST, identifier: str) -> ast.AST | str | None:
        owner = scope(node)
        while owner is not None:
            value = bindings.get((owner, identifier))
            if value is not None:
                return value
            # Python local names shadow outer bindings even before assignment.
            if isinstance(owner, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                argument = next((arg for arg in owner.args.args if arg.arg == identifier), None)
                if argument is not None:
                    return parameters.get(argument, argument)
            owner = scope(owner)
        return None
    def bind_assignment(node: ast.AST) -> None:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                if isinstance(target, ast.Name):
                    bind(node, target.id, node.value)
    def collect_binding(node: ast.AST) -> None:
        if not active(node):
            return
        if isinstance(node, ast.Import):
            for alias in node.names:
                bind(node, alias.asname or alias.name, alias.name)
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                bind(node, alias.asname or alias.name, (node.module or '') + '.' + alias.name)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            bind(node, node.name, node)
        if isinstance(node, ast.withitem) and isinstance(node.optional_vars, ast.Name):
            bind(node, node.optional_vars.id, node.context_expr)
        bind_assignment(node)
    for node in ast.walk(tree):
        collect_binding(node)
    def yields(function: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.Yield | ast.YieldFrom]:
        return sorted((part for part in ast.walk(function) if isinstance(part, (ast.Yield, ast.YieldFrom)) and scope(part) is function), key=lambda part: (part.lineno, part.col_offset))
    def suspended(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
        # Even an unreachable yield changes Python's calling convention.
        return isinstance(function, ast.AsyncFunctionDef) or bool(yields(function))
    def resolve(node: ast.AST | str | None, seen: set[ast.AST] | None = None) -> ast.AST | str | None:
        seen = set() if seen is None else seen
        if node is None or isinstance(node, str) or node in seen:
            return node
        seen.add(node)
        if isinstance(node, ast.Name):
            return resolve(lookup(node, node.id), seen)
        if isinstance(node, ast.Call):
            target = resolve(node.func, seen.copy())
            if isinstance(target, (ast.FunctionDef, ast.AsyncFunctionDef)) and not suspended(target):
                returns = [part.value for part in ast.walk(target) if isinstance(part, ast.Return) and scope(part) is target and active(part)]
                if len(returns) == 1:
                    return resolve(returns[0], seen)
        return node
    def name(node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            target = resolve(node)
            return target if isinstance(target, str) else node.id
        if isinstance(node, ast.Attribute):
            return name(node.value) + '.' + node.attr
        return ''
    def literal(node: ast.AST | str | None, seen: set[ast.AST] | None = None) -> str | None:
        seen = set() if seen is None else seen
        if node is None or isinstance(node, str) or node in seen:
            return None
        seen.add(node)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            return literal(lookup(node, node.id), seen)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = literal(node.left, seen.copy()), literal(node.right, seen.copy())
            return left + right if left is not None and right is not None else None
        return None
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and active(node)]
    errors: list[Problem] = []
    reachable: dict[ast.AST | None, list[int]] = {tree: []} if operational else {}
    # A call constructs a distinct suspended object. Consumers, not constructors,
    # grant body segments; one next() stops at the first yield, not after it.
    drives: dict[tuple[ast.Call, ...], dict[ast.AST, int | None]] = {}
    segments: dict[ast.AST, int | None] = {}
    def problem(node: ast.AST, code: str) -> None:
        error: Problem = {'line': getattr(node, 'lineno', 1), 'symbol': ast.get_source_segment(source, node) or ast.unparse(node), 'code': code}
        if error not in errors:
            errors.append(error)
    def executed(node: ast.AST) -> bool:
        owner = scope(node)
        if owner not in reachable:
            return False
        if isinstance(owner, (ast.FunctionDef, ast.AsyncFunctionDef)) and yields(owner):
            budget = segments.get(owner, 0)
            preceding = sum((part.lineno, part.col_offset) < (getattr(node, 'lineno', 0), getattr(node, 'col_offset', 0)) for part in yields(owner) if active(part))
            return budget is None or preceding < budget
        return True
    def construction(value: ast.AST, context: tuple[ast.Call, ...] = (), seen: set[ast.AST] | None = None) -> tuple[tuple[ast.Call, ...], ast.FunctionDef | ast.AsyncFunctionDef] | None:
        seen = set() if seen is None else seen
        if value in seen:
            return None
        seen.add(value)
        if isinstance(value, ast.Name):
            binding = lookup(value, value.id)
            return construction(binding, context, seen) if isinstance(binding, ast.AST) else None
        if isinstance(value, ast.Call):
            function = resolve(value.func)
            if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                identity = (*context, value)
                if suspended(function):
                    return identity, function
                returns = [part.value for part in ast.walk(function) if isinstance(part, ast.Return) and scope(part) is function and active(part)]
                if len(returns) == 1 and returns[0] is not None:
                    return construction(returns[0], identity, seen)
        return None
    def activate(function: ast.FunctionDef | ast.AsyncFunctionDef, site: ast.AST, arguments: list[ast.expr]) -> bool:
        for parameter, argument in zip(function.args.args, arguments):
            parameters[parameter] = argument
        if function in reachable:
            return False
        reachable[function] = reachable[scope(site)] + [getattr(site, 'lineno', 1)]
        return True
    def closed_before(created: tuple[tuple[ast.Call, ...], ast.FunctionDef | ast.AsyncFunctionDef], site: ast.AST) -> bool:
        for closed in calls:
            if not executed(closed) or not isinstance(closed.func, ast.Attribute) or closed.func.attr != 'close' or construction(closed.func.value) != created:
                continue
            if scope(closed) is scope(site):
                if (closed.lineno, closed.col_offset) < (getattr(site, 'lineno', 0), getattr(site, 'col_offset', 0)):
                    return True
            else:
                problem(site, 'unresolved_python_suspended_order')
                return True
        return False
    def supported_consumer(function: ast.FunctionDef | ast.AsyncFunctionDef, site: ast.AST, asynchronous: bool) -> bool:
        if isinstance(function, ast.AsyncFunctionDef) != asynchronous:
            problem(site, 'unsupported_python_suspended_consumer')
            return False
        pauses = [part for part in yields(function) if active(part)]
        if isinstance(function, ast.AsyncFunctionDef) and bool(yields(function)) != isinstance(site, ast.AsyncFor):
            problem(site, 'unsupported_python_suspended_consumer')
            return False
        if pauses and any(isinstance(part, ast.YieldFrom) or not isinstance(parents.get(part), ast.Expr) or parents.get(parents.get(part, part)) is not function for part in pauses):
            problem(site, 'unsupported_python_generator_control_flow')
            return False
        return True
    def consume(value: ast.AST, site: ast.AST, budget: int | None, asynchronous: bool) -> bool:
        created = construction(value)
        if created is None:
            if asynchronous:
                problem(site, 'unresolved_python_suspended_consumer')
            return False
        identity, function = created
        call = identity[-1]
        if closed_before(created, site):
            return False
        if not supported_consumer(function, site, asynchronous):
            return False
        sites = drives.setdefault(identity, {})
        if site in sites:
            return False
        sites[site] = budget
        limits = list(sites.values())
        total = None if None in limits else sum(limit for limit in limits if limit is not None)
        previous = segments.get(function, 0)
        segments[function] = None if previous is None or total is None else max(previous, total)
        changed = activate(function, site, call.args)
        # Retain both construction and the actual driving edge in provenance.
        reachable[function] = reachable[scope(site)] + [part.lineno for part in identity] + [getattr(site, 'lineno', 1)]
        return changed or previous != segments[function]
    def start_thread(call: ast.Call) -> bool:
        changed = False
        thread = resolve(call.func.value) if isinstance(call.func, ast.Attribute) and call.func.attr == 'start' else None
        if isinstance(thread, ast.Call) and name(thread.func) == 'threading.Thread':
            target = next((resolve(keyword.value) for keyword in thread.keywords if keyword.arg == 'target'), None)
            if isinstance(target, (ast.FunctionDef, ast.AsyncFunctionDef)) and not suspended(target):
                arguments = next((keyword.value for keyword in thread.keywords if keyword.arg == 'args'), None)
                changed = activate(target, call, arguments.elts if isinstance(arguments, (ast.Tuple, ast.List)) else []) or changed
        return changed
    def drive_method(call: ast.Call) -> bool:
        changed = False
        if isinstance(call.func, ast.Attribute) and call.func.attr in ('__next__', 'send', 'close', 'throw'):
            created = construction(call.func.value)
            if created:
                if call.func.attr == '__next__' or call.func.attr == 'send' and len(call.args) == 1 and isinstance(call.args[0], ast.Constant) and call.args[0].value is None:
                    changed = consume(call.func.value, call, 1, False) or changed
                elif call.func.attr != 'close' or drives.get(created[0]) and any(isinstance(part, ast.Try) and part.finalbody for part in ast.walk(created[1])):
                    problem(call, 'unsupported_python_suspended_consumer')
        return changed
    def discover_call(call: ast.Call) -> bool:
        changed = False
        if not executed(call):
            return False
        target = resolve(call.func)
        if isinstance(target, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for parameter, argument in zip(target.args.args, call.args):
                parameters[parameter] = argument
            if not suspended(target):
                changed = activate(target, call, call.args) or changed
        operation = name(call.func)
        if operation == 'asyncio.run' and call.args:
            changed = consume(call.args[0], call, None, True) or changed
        if operation in ('list', 'tuple', 'set', 'frozenset', 'sum', 'next') and lookup(call.func, operation) is None and call.args:
            changed = consume(call.args[0], call, 1 if operation == 'next' else None, False) or changed
        changed = drive_method(call) or changed
        changed = start_thread(call) or changed
        return changed
    def discover_node(node: ast.AST) -> bool:
        changed = False
        if not active(node) or not executed(node):
            return False
        if isinstance(node, ast.Await):
            changed = consume(node.value, node, None, True) or changed
        if isinstance(node, (ast.For, ast.AsyncFor)):
            # An unconditional first-iteration break drives only one segment.
            stops = [part for part in node.body if isinstance(part, (ast.Break, ast.Return, ast.Raise))]
            nested_stops = [part for statement in node.body for part in ast.walk(statement) if isinstance(part, (ast.Break, ast.Return, ast.Raise))]
            if nested_stops and not stops and construction(node.iter):
                problem(node, 'unsupported_python_generator_control_flow')
            else:
                changed = consume(node.iter, node, 1 if stops else None, isinstance(node, ast.AsyncFor)) or changed
        return changed
    def discover_reachable() -> None:
        changed = True
        while changed:
            changed = False
            for call in calls:
                changed = discover_call(call) or changed
            for node in ast.walk(tree):
                changed = discover_node(node) or changed
    discover_reachable()
    # Passing a suspended object to an unmodeled consumer cannot silently certify
    # zero. Local helpers are followed above; close/iter do not run an untouched body.
    def validate_consumer(call: ast.Call) -> None:
        if not executed(call):
            return
        target = resolve(call.func)
        operation = name(call.func)
        if isinstance(target, (ast.FunctionDef, ast.AsyncFunctionDef)) or operation in ('asyncio.run', 'list', 'tuple', 'set', 'frozenset', 'sum', 'next', 'iter', 'threading.Thread'):
            return
        if any(construction(argument) for argument in call.args) or isinstance(call.func, ast.Attribute) and call.func.attr not in ('close', '__next__', 'send', 'throw') and construction(call.func.value):
            problem(call, 'unresolved_python_suspended_consumer')
    for call in calls:
        validate_consumer(call)
    def connection(node: ast.AST | str | None, seen: set[ast.AST] | None = None) -> ast.Call | None:
        seen = set() if seen is None else seen
        node = resolve(node)
        if node is None or isinstance(node, str) or node in seen:
            return None
        seen.add(node)
        if isinstance(node, ast.Call):
            if name(node.func) == 'sqlite3.connect':
                return node
            if isinstance(node.func, ast.Attribute) and node.func.attr in ('cursor', 'execute', 'executemany', 'executescript'):
                return connection(node.func.value, seen)
        if isinstance(node, ast.Attribute) and node.attr == 'connection':
            return connection(node.value, seen)
        return None
    boundaries: list[Boundary] = []
    external: list[Boundary] = []
    def record_file_method(call: ast.Call, symbol: str) -> None:
        if isinstance(call.func, ast.Attribute) and call.func.attr in ('read', 'readline', 'readlines', 'write', 'writelines'):
            receiver = call.func.value
            binding = resolve(receiver)
            if isinstance(binding, ast.Call) and name(binding.func) in ('open', 'io.open'):
                path_value = literal(binding.args[0]) if binding.args else None
                if path_value is None:
                    errors.append({'line': call.lineno, 'symbol': symbol, 'code': 'dynamic_python_file_family'})
                else:
                    boundaries.append({'line': call.lineno, 'symbol': symbol, 'family': path_value, 'kind': 'filesystem', 'read': call.func.attr in ('read', 'readline', 'readlines'), 'write': call.func.attr in ('write', 'writelines'), 'forwardingLines': reachable[scope(call)]})
    def record_sql(call: ast.Call, symbol: str) -> None:
        if isinstance(call.func, ast.Attribute) and call.func.attr in ('execute', 'executemany', 'executescript'):
            receiver = call.func.value
            if connection(receiver) is not None:
                sql = literal(call.args[0]) if call.args else None
                if sql is None:
                    errors.append({'line': call.lineno, 'symbol': symbol, 'code': 'dynamic_python_sql'})
                else:
                    boundaries.append({'line': call.lineno, 'symbol': symbol, 'sql': sql, 'kind': 'sqlite', 'forwardingLines': reachable[scope(call)]})
            elif not isinstance(resolve(call.func), (ast.FunctionDef, ast.AsyncFunctionDef)):
                errors.append({'line': call.lineno, 'symbol': symbol, 'code': 'unresolved_python_sql_receiver'})
    def record_boundary(call: ast.Call) -> None:
        if not executed(call):
            return
        operation = name(call.func)
        symbol = ast.get_source_segment(source, call) or ast.unparse(call)
        if operation in ('exec', 'eval'):
            # Runtime cell input is not owned source. Preserve this boundary;
            # do not invent stores or consumers from arbitrary submitted code.
            external.append({'line': call.lineno, 'symbol': symbol, 'kind': 'submitted-code'})
        if operation in ('open', 'io.open', 'pathlib.Path.open'):
            path_value = literal(call.args[0]) if call.args else None
            mode = literal(call.args[1]) if len(call.args) > 1 else 'r'
            if path_value is None or mode is None:
                errors.append({'line': call.lineno, 'symbol': symbol, 'code': 'dynamic_python_file_family'})
            else:
                boundaries.append({'line': call.lineno, 'symbol': symbol, 'family': path_value, 'kind': 'filesystem', 'read': False, 'write': any(flag in mode for flag in ('w', 'x')), 'forwardingLines': reachable[scope(call)]})
        record_file_method(call, symbol)
        record_sql(call, symbol)
    for call in calls:
        record_boundary(call)
    return {'path': path, 'complete': not errors, 'boundaries': boundaries, 'errors': errors, 'externalCode': external, 'reachableFunctions': sorted(node.name for node in reachable if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)))}


def main() -> int:
    payload = load_input(json.load)
    result: Report = {'version': 1, 'python': sys.version.split()[0], 'sources': []}
    for source in payload['sources']:
        try:
            result['sources'].append(analyze(source['text'], source['path'], source['operational']))
        except SyntaxError as error:
            result['sources'].append({'path': source['path'], 'complete': False, 'boundaries': [], 'externalCode': [], 'reachableFunctions': [], 'errors': [{'line': error.lineno or 1, 'symbol': error.msg, 'code': 'python_syntax'}]})
    json.dump(result, sys.stdout, separators=(',', ':'))
    _ = sys.stdout.write('\n')
    return 0 if all(source['complete'] for source in result['sources']) else 2


if __name__ == '__main__':
    sys.exit(main())
