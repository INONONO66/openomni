import { array, object, text, integer, fail, type Json } from "./input";
function number(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail("schema", "", "expected finite number");
  return value;
}
function boolean(value: Json | undefined): boolean {
  if (typeof value !== "boolean") fail("schema", "", "expected boolean");
  return value;
}
function counts(value: Json | undefined) {
  return Object.fromEntries(Object.entries(object(value)).map(([key, n]) => [key, integer(n)]));
}
/** Test/consumer projection validates machine-consumed output, not prose. */
export function parseResult(value: Json) {
  const v = object(value),
    coverage = object(v.coverage),
    complete = object(v.completeness),
    duplication = object(v.duplication),
    settings = object(duplication.settings);
  return {
    complete: boolean(v.complete),
    tools: array(v.tools).map((value) => {
      const t = object(value);
      return { name: text(t.name), version: text(t.version) };
    }),
    coverage: { processes: array(coverage.processes) },
    pythonProcesses: array(v.pythonProcesses).map((value) => ({
      runtime: text(object(value).runtime),
    })),
    completeness: {
      files: integer(complete.files),
      historical: integer(complete.historical),
      embedded: integer(complete.embedded),
      configurations: integer(complete.configurations),
      measuredSources: integer(complete.measuredSources),
      nonExecutable: array(complete.nonExecutable),
    },
    records: array(v.records).map((value) => {
      const r = object(value),
        h = object(r.halstead),
        c = object(r.coverage);
      return {
        name: text(r.name),
        kind: text(r.kind),
        path: text(r.path),
        cyclomatic: integer(r.cyclomatic),
        cognitive: integer(r.cognitive),
        crap: number(r.crap),
        halstead: {
          n1: integer(h.n1),
          n2: integer(h.n2),
          N1: integer(h.N1),
          N2: integer(h.N2),
          difficulty: number(h.difficulty),
          operands: counts(h.operands),
        },
        coverage: {
          fraction: number(c.fraction),
          total: integer(c.total),
          hit: integer(c.hit),
          statementIds: array(c.statementIds).map(text),
        },
      };
    }),
    findings: array(v.findings).map((value) => ({ class: text(object(value).class) })),
    duplication: {
      production: integer(duplication.production),
      test: integer(duplication.test),
      inspected: array(duplication.inspected),
      settings: { maxLines: integer(settings.maxLines) },
      clusters: array(duplication.clusters).map((value) => {
        const c = object(value);
        return {
          id: text(c.id),
          tokenCount: integer(c.tokenCount),
          occurrences: array(c.occurrences).map((value) => ({ path: text(object(value).path) })),
        };
      }),
    },
  };
}
