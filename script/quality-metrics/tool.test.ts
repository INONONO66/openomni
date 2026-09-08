import { expect, spyOn, test } from "bun:test";
import { MetricsError, sha } from "./input";
import { invokeTool, toolReceipts } from "./tool";

// Existing clean-functions fixture; messages are machine-parsed by javascript.ts.
const source = `export function literal(){ return true; }
function logical(a:boolean,b:boolean){return a && b;}
function first(a:number){if(a)return 1;return 0;}
function second(a:number){if(a)return 2;return 0;}
console.log(literal(),logical(true,true),first(1)+first(0)+second(1)+second(0));`;
const request = { operation: "javascript", path: "a.ts", source, wrappers: [source] };
// Captured from the pinned process runner before the in-process change.
const expected = [[
  { ruleId: "complexity", fatal: false, line: 1, column: 8, message: "Function 'literal' has a complexity of 1. Maximum allowed is 0." },
  { ruleId: "complexity", fatal: false, line: 2, column: 1, message: "Function 'logical' has a complexity of 2. Maximum allowed is 0." },
  { ruleId: "sonarjs/cognitive-complexity", fatal: false, line: 2, column: 10, message: "Refactor this function to reduce its Cognitive Complexity from 1 to the 0 allowed." },
  { ruleId: "complexity", fatal: false, line: 3, column: 1, message: "Function 'first' has a complexity of 2. Maximum allowed is 0." },
  { ruleId: "sonarjs/cognitive-complexity", fatal: false, line: 3, column: 10, message: "Refactor this function to reduce its Cognitive Complexity from 1 to the 0 allowed." },
  { ruleId: "complexity", fatal: false, line: 4, column: 1, message: "Function 'second' has a complexity of 2. Maximum allowed is 0." },
  { ruleId: "sonarjs/cognitive-complexity", fatal: false, line: 4, column: 10, message: "Refactor this function to reduce its Cognitive Complexity from 1 to the 0 allowed." },
]];

test("unsupported analyzer operation fails with a typed analyzer error", () => {
  const run = () => invokeTool({ operation: "unsupported" });
  expect(run).toThrow(MetricsError);
  expect(run).toThrow("unsupported analyzer operation");
});

test("coverage unmapped position preserves the typed analyzer error", () => {
  const run = () => invokeTool({
    operation: "coverage", path: "a.js", code: "const answer = 42;",
    sourceMap: JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "" }),
  });
  expect(run).toThrow(MetricsError);
  expect(run).toThrow("unmapped generated position 1:15");
});

test("javascript in-process result equals the previous process fixture JSON without spawning", () => {
  toolReceipts();
  const spawn = spyOn(Bun, "spawnSync");
  try {
    expect(invokeTool(request)).toEqual(expected);
    // A second request uses cached analyzers without leaking the first result.
    expect(invokeTool({ ...request, source: "", wrappers: [""] })).toEqual([[]]);
    expect(invokeTool(request)).toEqual(expected);
    expect(spawn).not.toHaveBeenCalled();
    const receipts = toolReceipts();
    expect(receipts).toHaveLength(3);
    expect(receipts[0]).toEqual({
      operation: "javascript", transport: "in-process",
      inputHash: sha(JSON.stringify(request)),
      outputHash: sha(`${JSON.stringify({ ok: true, result: expected })}\n`),
    });
  } finally {
    spawn.mockRestore();
    toolReceipts();
  }
});
