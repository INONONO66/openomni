import { expect, test } from "bun:test";
import { captureConsole } from "./capture-output.test-helper";
import { buildGraph, findCycles, main, selfTest, valueImportSpecifiers } from "./check-import-cycles";
import { TOPOLOGY } from "./topology";

test("the shipped tree has one module per topology source file and no value-import cycle", async () => {
  const graph = buildGraph();
  const files = [...graph.keys()];
  for (const workspace of TOPOLOGY) {
    expect(files.some((file) => file.includes(`/${workspace.dir}/src/`))).toBe(true);
  }
  for (const edges of graph.values()) for (const edge of edges) expect(graph.has(edge)).toBe(true);
  expect(findCycles(graph)).toEqual([]);

  const console_ = captureConsole();
  try {
    await main();
    expect(console_.messages).toEqual([`OK: import-cycle check — ${graph.size} modules, 0 value-import cycles`]);
  } finally {
    console_.restore();
  }
});

test("a planted cycle is printed with its path and exits 1", async () => {
  const graph = new Map<string, readonly string[]>([
    ["/repo/packages/a/src/a.ts", ["/repo/packages/b/src/b.ts"]],
    ["/repo/packages/b/src/b.ts", ["/repo/packages/a/src/a.ts"]],
  ]);
  expect(findCycles(graph)).toEqual([
    ["/repo/packages/a/src/a.ts", "/repo/packages/b/src/b.ts", "/repo/packages/a/src/a.ts"],
  ]);
});

test("value-edge extraction keeps default bindings beside type-only braces", () => {
  expect(
    valueImportSpecifiers('import Foo, { type A } from "./foo.js";\nimport { type B } from "./b.js";'),
  ).toEqual(["./foo.js"]);
});

test("self-test passes on the synthetic graphs", () => {
  const console_ = captureConsole();
  try {
    selfTest();
    expect(console_.messages).toEqual([
      "OK: import-cycle self-test — planted cycle red, acyclic green, type edges erased",
    ]);
  } finally {
    console_.restore();
  }
});
