import ts from "typescript";
import { coverageForMetrics } from "../check-quality-coverage";
import type { Location, Range } from "istanbul-lib-coverage";
import { invokeTool } from "./tool";
import {
  array,
  fail,
  hash,
  integer,
  object,
  readJson,
  sha,
  text,
  type Inventory,
  type Json,
  type Source,
} from "./input";
import type { Unit } from "./javascript";

export type FunctionMap = { name: string; decl: Range; loc: Range };
export type Prepared = {
  path: string;
  sha256: string;
  mapHash: string;
  statementMap: Record<string, Range>;
  fnMap: Record<string, FunctionMap>;
  code: string;
};
export type Counters = { s: Record<string, number>; f: Record<string, number> };

/** Reconstruct the complete expected Istanbul map, rather than trusting the
 * subset a coverage producer happened to send. Original-source maps are part
 * of the receipt hash. This is preparation, not a second coverage collector.
 */
export function prepare(source: Source): Prepared {
  if (/\.d\.[cm]?ts$/.test(source.path)) {
    const maps = { statementMap: {}, fnMap: {} };
    return {
      path: source.path,
      sha256: source.sha256,
      mapHash: sha(JSON.stringify({ source: source.sha256, ...maps })),
      ...maps,
      code: "",
    };
  }
  const emitted = ts.transpileModule(source.text, {
    fileName: source.path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
      sourceMap: true,
      inlineSources: true,
      removeComments: true,
    },
  });
  if (
    !emitted.sourceMapText ||
    emitted.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)
  )
    fail("syntax", source.path, "cannot emit source for coverage map");
  const raw = object(
    invokeTool({
      operation: "coverage",
      path: source.path,
      code: emitted.outputText.replace(/\/\/# sourceMappingURL=.*$/m, ""),
      sourceMap: emitted.sourceMapText,
    }),
  );
  const code = text(raw.code);
  function position(value: Json | undefined): Location {
    const p = object(value);
    const result = { line: integer(p.line), column: integer(p.column) };
    offset(source, result);
    return result;
  }
  function range(value: Json): Range {
    const r = object(value),
      start = position(r.start),
      end = position(r.end);
    if (start.line > end.line || (start.line === end.line && start.column > end.column))
      fail("source_map", source.path, "reversed original range");
    return { start, end };
  }
  const statementMap = Object.fromEntries(
    Object.entries(object(raw.statementMap)).map(([id, r]) => [id, range(r)]),
  );
  const fnMap = Object.fromEntries(
    Object.entries(object(raw.fnMap)).map(([id, value]) => {
      const f = object(value);
      if (f.decl === undefined || f.loc === undefined)
        fail("source_map", source.path, "missing function map");
      return [id, { name: text(f.name), decl: range(f.decl), loc: range(f.loc) }];
    }),
  );
  const mapHash = sha(
    JSON.stringify({
      source: source.sha256,
      statementMap,
      fnMap,
      generatedStatements: raw.generatedStatements,
      generatedFunctions: raw.generatedFunctions,
      sourceMap: emitted.sourceMapText,
      code,
    }),
  );
  return { path: source.path, sha256: source.sha256, mapHash, statementMap, fnMap, code };
}
function counts(
  value: Json | undefined,
  expected: readonly string[],
  path: string,
): Record<string, number> {
  const v = object(value);
  if (Object.keys(v).sort().join("\0") !== [...expected].sort().join("\0"))
    fail("coverage", path, "partial or unexpected counters");
  return Object.fromEntries(Object.entries(v).map(([id, n]) => [id, integer(n)]));
}
function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail("coverage", path, "duplicate identity");
}
type CollectorPaths = { root: string; contract: string; inventory: string; plan: string };
type ReceiptObject = ReturnType<typeof object>;
type VerifiedCollector = ReturnType<typeof coverageForMetrics>;
function joinCollectorFile(file: Prepared, original: VerifiedCollector["files"][number], processes: VerifiedCollector["processes"]): Counters {
  const counters: Counters = { s: {}, f: {} };
  for (const kind of ["s", "f"] as const) {
    const expected: Record<string, Range | FunctionMap> = kind === "s" ? file.statementMap : file.fnMap;
    const actual: Record<string, Range | FunctionMap> = kind === "s" ? original.mapped.statementMap : Object.fromEntries(Object.entries(original.mapped.fnMap).map(([key, fn]) => [key, { name: fn.name, decl: fn.decl, loc: fn.loc }]));
    const used = new Set<string>();
    for (const [id, range] of Object.entries(expected)) {
      const matches = Object.entries(actual).filter(([key, candidate]) => !used.has(key) && JSON.stringify(candidate) === JSON.stringify(range));
      const match = matches[0];
      if (!match) fail("coverage", file.path, `original ${kind} range is absent from collector map`);
      used.add(match[0]);
      counters[kind][id] = processes.reduce((sum, process) => integer(sum + (process.coverage[file.path]?.[kind][match[0]] ?? 0)), 0);
    }
    if (used.size !== Object.keys(actual).length) fail("coverage", file.path, "collector map contains unmatched ranges");
  }
  return counters;
}
function collectorCoverage(path: string, receipt: ReceiptObject, prepared: Prepared[], collector: CollectorPaths) {
  const verified = coverageForMetrics({ ...collector, coverage: path });
  const totals = new Map<string, Counters>();
  for (const file of prepared) {
    const original = verified.files.find((source) => source.path === file.path);
    if (!original || original.sha256 !== file.sha256) fail("identity", file.path, "collector source differs");
    const counters = joinCollectorFile(file, original, verified.processes);
    totals.set(file.path, counters);
  }
  if (totals.size !== verified.files.length) fail("coverage", path, "collector source membership differs");
  return { run: { id: sha(JSON.stringify(receipt)), inventoryHash: hash(receipt.inventoryHash), contractHash: hash(receipt.contractHash), planHash: hash(receipt.planHash) }, totals,
    processes: verified.processes.map((process) => ({ id: process.id, parent: process.parent, children: process.children, exitCode: process.exitCode })),
    receiptHash: sha(JSON.stringify(receipt)) };
}
function coverageFiles(path: string, receipt: ReceiptObject, prepared: Prepared[]) {
  const files = array(receipt.files).map((v) => object(v));
  const paths = files.map((v) => text(v.path));
  unique(paths, path);
  if (
    paths.sort().join("\0") !==
    prepared
      .map((p) => p.path)
      .sort()
      .join("\0")
  )
    fail("coverage", path, "complete file map required");
  const totals = new Map<string, Counters>();
  for (const file of files) {
    const p = prepared.find((p) => p.path === text(file.path));
    if (!p) fail("coverage", path, "unmapped file");
    if (hash(file.sha256) !== p.sha256 || hash(file.mapHash) !== p.mapHash)
      fail("identity", p.path, "stale source/map identity");
    if (
      JSON.stringify(file.statementMap) !== JSON.stringify(p.statementMap) ||
      JSON.stringify(file.fnMap) !== JSON.stringify(p.fnMap)
    )
      fail("coverage", p.path, "statement/function map is partial or modified");
    totals.set(p.path, {
      s: counts(file.s, Object.keys(p.statementMap), p.path),
      f: counts(file.f, Object.keys(p.fnMap), p.path),
    });
  }
  return totals;
}
function coverageProcesses(path: string, receipt: ReceiptObject) {
  const processes = array(receipt.processes).map((v) => {
    const p = object(v);
    if (p.completed !== true) fail("coverage", path, "process termination missing");
    return {
      id: text(p.id),
      parent: text(p.parent),
      children: array(p.children).map(text),
      exitCode: integer(p.exitCode),
      files: array(p.files).map(object),
    };
  });
  if (!processes.length) fail("coverage", path, "no process receipt");
  unique(
    processes.map((p) => p.id),
    path,
  );
  const roots = array(receipt.roots).map(text);
  unique(roots, path);
  if (
    !roots.length ||
    roots.sort().join("\0") !==
      processes
        .filter((p) => !p.parent)
        .map((p) => p.id)
        .sort()
        .join("\0")
  )
    fail("coverage", path, "root process set differs");
  return processes;
}
type CoverageProcesses = ReturnType<typeof coverageProcesses>;
function validateProcessGraph(p: CoverageProcesses[number], processes: CoverageProcesses): void {
  unique(p.children, p.id);
  if (
    p.parent &&
    !processes.some((parent) => parent.id === p.parent && parent.children.includes(p.id))
  )
    fail("coverage", p.id, "orphan process");
  for (const child of p.children)
    if (!processes.some((c) => c.id === child && c.parent === p.id))
      fail("coverage", p.id, "missing child process");
  const seen = new Set<string>();
  let cursor: typeof p | undefined = p;
  while (cursor) {
    if (seen.has(cursor.id)) fail("coverage", p.id, "cyclic process graph");
    seen.add(cursor.id);
    cursor = processes.find((c) => c.id === cursor?.parent);
  }
}
function mergeProcesses(prepared: Prepared[], processes: ReturnType<typeof coverageProcesses>) {
  const merged = new Map(
    prepared.map((p) => [
      p.path,
      {
        s: Object.fromEntries(Object.keys(p.statementMap).map((k) => [k, 0])),
        f: Object.fromEntries(Object.keys(p.fnMap).map((k) => [k, 0])),
      },
    ]),
  );
  for (const p of processes) {
    validateProcessGraph(p, processes);
    unique(
      p.files.map((f) => text(f.path)),
      p.id,
    );
    for (const f of p.files) {
      const file = prepared.find((file) => file.path === text(f.path));
      if (!file || hash(f.sha256) !== file.sha256 || hash(f.mapHash) !== file.mapHash)
        fail("identity", p.id, "unmapped process source");
      const out = merged.get(file.path);
      if (!out) fail("coverage", file.path, "missing counter accumulator");
      for (const key of ["s", "f"] as const) {
        const map = key === "s" ? file.statementMap : file.fnMap;
        for (const [id, n] of Object.entries(counts(f[key], Object.keys(map), file.path)))
          out[key][id] = integer((out[key][id] ?? 0) + n);
      }
    }
  }
  return merged;
}
export function loadCoverage(path: string, inventory: Inventory, prepared: Prepared[], collector?: CollectorPaths) {
  const receipt = object(readJson(path));
  if (receipt.version === 1) {
    if (!collector) fail("coverage", path, "collector receipts require --contract and --plan");
    return collectorCoverage(path, receipt, prepared, collector);
  }
  if (receipt.version !== 2 || receipt.complete !== true)
    fail("coverage", path, "complete original-source receipt version 2 required");
  if (
    hash(receipt.inventoryHash) !== inventory.inventoryHash ||
    hash(receipt.contractHash) !== inventory.contractHash
  )
    fail("identity", path, "coverage inventory/contract differs");
  const run = object(receipt.run);
  const runId = text(run.id),
    head = text(run.head),
    tree = text(run.tree);
  if (!runId || !/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(tree))
    fail("identity", path, "coverage run/head/tree missing");
  const totals = coverageFiles(path, receipt, prepared);
  const processes = coverageProcesses(path, receipt);
  const merged = mergeProcesses(prepared, processes);
  for (const [path, total] of totals) {
    if (JSON.stringify(total) !== JSON.stringify(merged.get(path)))
      fail("coverage", path, "aggregate differs from complete process counters");
  }
  return {
    run: { id: runId, head, tree },
    totals,
    processes: processes.map(({ id, parent, children, exitCode }) => ({
      id,
      parent,
      children,
      exitCode,
    })),
    receiptHash: sha(JSON.stringify(receipt)),
  };
}
export type Coverage = ReturnType<typeof loadCoverage>;
function offset(source: Source, p: Location): number {
  const lines = source.text.split("\n");
  if (
    !Number.isInteger(p.line) ||
    !Number.isInteger(p.column) ||
    p.line < 1 ||
    p.line > lines.length ||
    p.column < 0 ||
    p.column > (lines[p.line - 1]?.length ?? 0)
  )
    fail("coverage", source.path, "position outside original source");
  return lines.slice(0, p.line - 1).reduce((n, line) => n + line.length + 1, 0) + p.column;
}
export function joinCoverage(
  source: Source,
  units: Unit[],
  prepared: Prepared,
  counters: Counters,
) {
  const statements = new Map<Unit, string[]>(),
    functions = new Map<Unit, string[]>();
  for (const unit of units) {
    statements.set(unit, []);
    functions.set(unit, []);
  }
  function owner(start: number, end: number, functionMap: boolean): Unit {
    const candidates = units.filter(
      (u) =>
        (functionMap ? !["module", "static", "field", "python-class"].includes(u.kind) : true) &&
        start >= (functionMap ? u.start : u.body.start) &&
        end <= u.body.end,
    );
    candidates.sort((a, b) => a.body.end - a.body.start - (b.body.end - b.body.start));
    const result = candidates[0];
    if (!result)
      fail(
        "coverage",
        source.path,
        `unmapped ${functionMap ? "function" : "statement"} range ${start}:${end}`,
      );
    return result;
  }
  for (const [id, r] of Object.entries(prepared.statementMap)) {
    const unit = owner(offset(source, r.start), offset(source, r.end), false);
    statements.get(unit)?.push(id);
  }
  for (const [id, f] of Object.entries(prepared.fnMap)) {
    const unit = owner(
      Math.min(offset(source, f.decl.start), offset(source, f.loc.start)),
      offset(source, f.loc.end),
      true,
    );
    functions.get(unit)?.push(id);
  }
  return units.map((unit) => {
    const ids = statements.get(unit) ?? [],
      fnIds = functions.get(unit) ?? [];
    if (
      !["module", "namespace", "static", "field", "python-class"].includes(unit.kind) &&
      fnIds.length !== 1
    )
      fail("coverage", source.path, `missing or ambiguous function map at ${unit.start}`);
    const hit = ids.filter((id) => (counters.s[id] ?? 0) > 0).length;
    const functionHit = fnIds.some((id) => (counters.f[id] ?? 0) > 0);
    const fraction = ids.length ? hit / ids.length : fnIds.length ? Number(functionHit) : 1;
    return {
      ...unit,
      sourceSha256: source.sha256,
      category: source.category,
      language: source.language,
      ...(source.hostPath ? { hostPath: source.hostPath, hostOffset: source.hostOffset } : {}),
      coverage: {
        statementIds: ids,
        functionIds: fnIds,
        total: ids.length,
        hit,
        fraction,
        notApplicable: ids.length === 0 && fnIds.length === 0,
      },
      crap: unit.cyclomatic ** 2 * (1 - fraction) ** 3 + unit.cyclomatic,
    };
  });
}
