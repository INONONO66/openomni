import { join } from "node:path";
import { array, decode, fail, integer, object, sha, text, type Json, type Source } from "./input";
import type { Unit } from "./javascript";
import type { Prepared } from "./coverage";

function number(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail("python", "", "invalid metric value");
  return value;
}
function span(value: Json | undefined) {
  const v = object(value);
  return { start: integer(v.start), end: integer(v.end) };
}
function position(value: Json | undefined) {
  const v = object(value);
  return { line: integer(v.line), column: integer(v.column) };
}
function range(value: Json | undefined) {
  const v = object(value);
  return { start: position(v.start), end: position(v.end) };
}
export function analyzePython(source: Source): {
  units: Unit[];
  prepared: Prepared;
  receipt: { pid: number; exitCode: number; runtime: string; outputHash: string };
} {
  const process = Bun.spawnSync(
    [Bun.env.D945_PYTHON ?? "python3", join(import.meta.dir, "python.py")],
    {
      stdin: Buffer.from(JSON.stringify({ text: source.text, path: source.path })),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  if (process.exitCode !== 0)
    fail("python", source.path, `adapter failed: ${process.stderr.toString()}`);
  const output = object(decode(process.stdout.toString()));
  if (output.runtime !== "3.12.12") fail("toolchain", source.path, "Python version differs");
  const tools = object(output.tools);
  if (tools.radon !== "6.0.1" || tools["cognitive-complexity"] !== "1.3.0")
    fail("toolchain", source.path, "Python analyzer versions differ");
  const units = array(output.units).map((value) => {
    const u = object(value),
      h = object(u.halstead);
    return {
      path: text(u.path),
      kind: text(u.kind),
      name: text(u.name),
      ...span(u),
      body: span(u.body),
      line: integer(u.line),
      column: integer(u.column),
      endLine: integer(u.endLine),
      endColumn: integer(u.endColumn),
      cyclomatic: integer(u.cyclomatic),
      cognitive: integer(u.cognitive),
      wrapperHash: text(u.wrapperHash),
      halstead: {
        algorithm: text(h.algorithm),
        n1: integer(h.n1),
        n2: integer(h.n2),
        N1: integer(h.N1),
        N2: integer(h.N2),
        difficulty: number(h.difficulty),
        volume: number(h.volume),
        effort: number(h.effort),
        operators: {},
        operands: {},
      },
    };
  });
  const statementMap = Object.fromEntries(
    Object.entries(object(output.statementMap)).map(([id, r]) => [id, range(r)]),
  );
  const fnMap = Object.fromEntries(
    Object.entries(object(output.fnMap)).map(([id, value]) => {
      const f = object(value);
      return [id, { name: text(f.name), decl: range(f.decl), loc: range(f.loc) }];
    }),
  );
  const code = text(output.code);
  const mapHash = sha(JSON.stringify({ source: source.sha256, statementMap, fnMap, code }));
  return {
    units,
    prepared: { path: source.path, sha256: source.sha256, mapHash, statementMap, fnMap, code },
    receipt: {
      pid: process.pid,
      exitCode: process.exitCode,
      runtime: text(output.runtime),
      outputHash: sha(process.stdout),
    },
  };
}
