import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const sources = [
  "apps/openomni/src/composition/alarm-sources.ts",
  "apps/openomni/src/composition/alarm-worker.ts",
  "apps/openomni/src/tools/mutation/monitor.ts",
  "apps/openomni/test/monitor-tool-boundaries.test.ts",
  "apps/openomni/test/monitor-budget.test.ts",
  "apps/openomni/test/monitor-deadline.test.ts",
  "apps/openomni/test/monitor-process-group.test.ts",
  "apps/openomni/test/monitor-errors.test.ts",
  "apps/openomni/test/helpers/alarm-payload.ts",
  "packages/ledger/src/storage/migration-runner.ts",
  "packages/ledger/test/storage/watch-migration.test.ts",
].map((path) => join(root, path));

function unsafeValues(paths: string[]) {
  const program = ts.createProgram(paths, {
    strict: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: ["bun"],
  });
  const checker = program.getTypeChecker();
  const failures: string[] = [];
  for (const path of paths) {
    const source = program.getSourceFile(path);
    if (source === undefined) throw new Error(`missing source ${path}`);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isVariableDeclaration(node)) {
        const value = ts.isVariableDeclaration(node) ? node.name : node;
        const type = checker.getTypeAtLocation(value);
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
          failures.push(
            `${path}:${source.getLineAndCharacterOfPosition(value.getStart()).line + 1}:${checker.typeToString(type)}`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return failures;
}

test("alarm boundary values have no compiler-inferred any or unknown", () => {
  expect(unsafeValues(sources)).toEqual([]);
});

test("alarm type contract rejects a raw JSON result and untyped catch binding", () => {
  const directory = mkdtempSync(join(tmpdir(), "alarm-type-mutant-"));
  try {
    const file = join(directory, "mutant.ts");
    writeFileSync(
      file,
      'const value = JSON.parse("{}"); try { throw new Error(); } catch (error) { String(error); }',
    );
    expect(unsafeValues([file])).toHaveLength(3); // binding + call result + catch binding
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
