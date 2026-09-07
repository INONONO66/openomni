import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseResult } from "./quality-metrics/result";
import { makeFixture, type FixtureSource } from "./quality-metrics/fixture";
import { analyzeJavascript } from "./quality-metrics/javascript";
import { detectClones } from "./quality-metrics/clones";
import { sha, decode, fail, object, type Json, type Source } from "./quality-metrics/input";
import { prepare } from "./quality-metrics/coverage";

type Result = ReturnType<typeof parseResult>;
type Fixture = ReturnType<typeof makeFixture>;
const evidence: {
  case: string;
  exit: number | null;
  stdout: string;
  stderr: string;
  fixtureProcesses: Fixture["processEvidence"];
}[] = [];
function cli(name: string, fixture: Fixture, args?: string[]) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "check-quality-metrics.ts"),
      ...(args ?? [
        "--root",
        fixture.root,
        "--inventory",
        fixture.inventoryPath,
        "--coverage",
        fixture.coveragePath,
      ]),
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 60_000 },
  );
  evidence.push({
    case: name,
    exit: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    fixtureProcesses: fixture.processEvidence,
  });
  return {
    exit: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    result: () => parseResult(decode(child.stdout.toString())),
  };
}
function withFixture(
  inputs: FixtureSource[],
  body: (f: Fixture) => void,
  engine: "bun" | "node" = "bun",
) {
  const f = makeFixture(inputs, engine);
  try {
    body(f);
  } finally {
    f.cleanup();
    expect(existsSync(f.root)).toBe(false);
  }
}
function source(text: string, path = "a.ts", category = "production"): Source {
  return {
    path,
    text,
    sha256: sha(text),
    bytes: Buffer.byteLength(text),
    language: path.endsWith(".py") ? "python" : "typescript",
    category,
  };
}
function named(result: Result, name: string) {
  const record = result.records.find((r) => r.name === name);
  expect(record).toBeDefined();
  if (!record) fail("fixture", "", `missing unit ${name}`);
  return record;
}
afterAll(() => {
  if (Bun.env.D945_CLI_RECEIPT)
    writeFileSync(Bun.env.D945_CLI_RECEIPT, `${JSON.stringify(evidence, null, 2)}\n`);
});

describe("reviewer counterexamples through actual pinned CLI", () => {
  test("clean executable, exact per-function decisions and Halstead raw counts", () => {
    const text = `export function literal(){ return true; }
function logical(a:boolean,b:boolean){return a && b;}
function first(a:number){if(a)return 1;return 0;}
function second(a:number){if(a)return 2;return 0;}
console.log(literal(),logical(true,true),first(1)+first(0)+second(1)+second(0));`;
    withFixture([{ path: "a.ts", text }], (f) => {
      expect(f.effects).toEqual(["true true 3\n"]);
      const out = cli("review-clean-functions", f);
      expect(out.exit).toBe(0);
      const result = out.result();
      expect(result.complete).toBe(true);
      expect(result.records.length).toBe(5);
      expect(named(result, "logical").cyclomatic).toBe(2);
      expect(named(result, "first").cyclomatic).toBe(2);
      expect(named(result, "second").cyclomatic).toBe(2);
      expect(named(result, "first").cognitive).toBe(1);
      const literal = named(result, "literal");
      expect([
        literal.halstead.n1,
        literal.halstead.N1,
        literal.halstead.n2,
        literal.halstead.N2,
        literal.halstead.difficulty,
      ]).toEqual([4, 4, 1, 1, 2]);
      expect(result.records.every((r) => r.coverage.fraction === 1)).toBe(true);
      expect(result.tools.find((t) => t.name === "eslint")?.version).toBe("9.36.0");
      expect(result.coverage.processes.length).toBe(1);
    });
  }, 60_000);

  test("CRAP cube at C10 and real 5/10 statement hits is 22.5, not 60", () => {
    const text = `let calls=0;
function hit(n:number){if(++calls===5)throw new Error(String(n));}
function partial(a:boolean){
${Array.from<number, string>({ length: 9 }, (_, n) => `a && hit(${n});`).join("\n")}
return 42;
}
try{partial(true);}catch{}
console.log(calls);`;
    withFixture([{ path: "partial.ts", text }], (f) => {
      expect(f.effects).toEqual(["5\n"]);
      const out = cli("review-crap-cube", f);
      expect(out.exit).toBe(0);
      const row = named(out.result(), "partial");
      expect(row.cyclomatic).toBe(10);
      expect([row.coverage.hit, row.coverage.total, row.coverage.fraction]).toEqual([5, 10, 0.5]);
      expect(row.crap).toBe(22.5);
    });
  }, 60_000);

  test("uncovered empty function uses function counter, nested statements stay separate", () => {
    withFixture(
      [
        {
          path: "nested.ts",
          text: `function empty(){}
function outer(){function inner(a:boolean){if(a)return 1;return 0;} return inner(true);}
console.log(outer());`,
        },
      ],
      (f) => {
        const out = cli("empty-and-nested", f);
        expect(out.exit).toBe(0);
        const result = out.result();
        const empty = named(result, "empty"),
          outer = named(result, "outer"),
          inner = named(result, "inner");
        expect(empty.coverage.fraction).toBe(0);
        expect(empty.crap).toBe(2);
        expect(outer.cyclomatic).toBe(1);
        expect(outer.coverage.total).toBe(1);
        expect(inner.cyclomatic).toBe(2);
        expect(inner.coverage.total).toBe(3);
        expect(inner.coverage.hit).toBe(2);
        expect(
          outer.coverage.statementIds.some((id) => inner.coverage.statementIds.includes(id)),
        ).toBe(false);
      },
    );
  }, 60_000);
});

describe("complete joins fail closed instead of accepting partial coverage", () => {
  const clean = [{ path: "a.ts", text: "function f(){return true;} console.log(f());" }];
  const corruptions: [string, (f: Fixture) => void][] = [
    [
      "missing-file",
      (f) => {
        f.receipt.files.length = 0;
      },
    ],
    [
      "missing-statement",
      (f) => {
        const file = f.receipt.files[0];
        if (file) delete file.s[Object.keys(file.s)[0] ?? ""];
      },
    ],
    [
      "missing-statement-map",
      (f) => {
        const file = f.receipt.files[0];
        if (file) delete file.statementMap[Object.keys(file.statementMap)[0] ?? ""];
      },
    ],
    [
      "missing-function-map",
      (f) => {
        const file = f.receipt.files[0];
        if (file) delete file.fnMap[Object.keys(file.fnMap)[0] ?? ""];
      },
    ],
    [
      "stale-source",
      (f) => {
        const file = f.receipt.files[0];
        if (file) file.sha256 = sha("stale");
      },
    ],
    [
      "stale-map",
      (f) => {
        const file = f.receipt.files[0];
        if (file) file.mapHash = sha("stale");
      },
    ],
    [
      "stale-inventory",
      (f) => {
        f.receipt.inventoryHash = sha("stale");
      },
    ],
    [
      "stale-contract",
      (f) => {
        f.receipt.contractHash = sha("stale");
      },
    ],
    [
      "missing-run",
      (f) => {
        f.receipt.run.id = "";
      },
    ],
    [
      "missing-child",
      (f) => {
        f.receipt.processes[0]?.children.push("absent-child");
      },
    ],
    [
      "duplicate-process",
      (f) => {
        const parent = f.receipt.processes[0];
        if (parent) f.receipt.processes.push({ ...parent });
      },
    ],
    [
      "cyclic-process-graph",
      (f) => {
        const parent = f.receipt.processes[0];
        if (parent) {
          parent.parent = parent.id;
          parent.children.push(parent.id);
        }
      },
    ],
    [
      "orphan-process",
      (f) => {
        const parent = f.receipt.processes[0];
        if (parent) parent.parent = "absent-parent";
      },
    ],
    [
      "missing-terminal",
      (f) => {
        const p = f.receipt.processes[0];
        if (p) p.completed = false;
      },
    ],
    [
      "partial-receipt",
      (f) => {
        f.receipt.complete = false;
      },
    ],
    [
      "bad-version",
      (f) => {
        f.receipt.version = 999;
      },
    ],
    [
      "fractional-counter",
      (f) => {
        const file = f.receipt.files[0];
        if (file) file.s["0"] = 0.5;
      },
    ],
    [
      "forged-aggregate",
      (f) => {
        const file = f.receipt.files[0];
        if (file) file.s = Object.fromEntries(Object.keys(file.s).map((k) => [k, 17]));
      },
    ],
  ];
  for (const [name, corrupt] of corruptions)
    test(name, () => {
      withFixture(clean, (f) => {
        corrupt(f);
        f.save();
        const out = cli(name, f);
        expect(out.exit).toBe(2);
        expect(out.stdout).toBe("");
        expect(out.stderr.length).toBeGreaterThan(0);
      });
    }, 60_000);
  test("synthetic parent-child redistribution preserves real aggregate counters", () => {
    // Given: real execution counts; only the graph-schema attribution is synthetic.
    withFixture(clean, (f) => {
      const parent = f.receipt.processes[0];
      if (!parent) fail("fixture", "", "parent receipt missing");
      const child = { ...parent, id: "synthetic-child", parent: parent.id, children: [] };
      parent.files = [];
      parent.children = [child.id];
      f.receipt.processes.push(child);
      f.save();
      // When: actual CLI validates the graph and aggregate join.
      const out = cli("synthetic-parent-child-graph", f);
      // Then: redistribution neither loses nor manufactures counter hits.
      expect(f.effects).toEqual(["true\n"]);
      expect(out.exit).toBe(0);
      expect(out.result().coverage.processes.length).toBe(2);
      expect(named(out.result(), "f").coverage.fraction).toBe(1);
    });
  }, 60_000);

  test("dynamic embedded source reports explicit inventory error, not clean", () => {
    // Given: executing the host cannot resolve a constant virtual-source identity.
    withFixture(
      [{ path: "host.ts", text: `const PYTHON_DRIVER=String.raw\`print(\${1})\`; console.log(1);` }],
      (f) => {
        writeFileSync(
          f.inventoryPath,
          JSON.stringify({
            ...f.inventory,
            embedded: [
              {
                path: "host.ts#PYTHON_DRIVER",
                sha256: sha("print(1)"),
                bytes: 8,
                category: "production",
                language: "python",
              },
            ],
          }),
        );
        // When: the actual CLI attempts the inventoried virtual-source join.
        const out = cli("dynamic-embedded-source", f);
        // Then: analysis is incomplete and distinct from policy findings.
        expect(out.exit).toBe(2);
        expect(out.stdout).toBe("");
        expect(object(decode(out.stderr))).toMatchObject({
          code: "inventory",
          path: "host.ts#PYTHON_DRIVER",
          complete: false,
        });
      },
    );
  }, 60_000);

  test("missing flags, malformed and legacy partial coverage, source tamper", () => {
    withFixture(clean, (f) => {
      expect(cli("missing-inventory", f, ["--coverage", f.coveragePath]).exit).toBe(2);
      expect(cli("missing-coverage", f, ["--inventory", f.inventoryPath]).exit).toBe(2);
      writeFileSync(f.coveragePath, "{");
      expect(cli("malformed-coverage", f).exit).toBe(2);
      writeFileSync(f.coveragePath, JSON.stringify({ data: { "a.ts": { s: { "0": 1 } } } }));
      expect(cli("legacy-partial-coverage", f).exit).toBe(2);
      f.save();
      writeFileSync(join(f.root, "a.ts"), "console.log(2)");
      expect(cli("source-tamper", f).exit).toBe(2);
    });
  }, 60_000);
});

describe("fixed equality boundaries and language forms", () => {
  test("cyclomatic22, cognitive22, Halstead80, CRAP25 are genuine findings", () => {
    const text = `function cyclo(a:number){${Array.from<number, string>({ length: 21 }, (_, i) => `if(a===${i})a++;`).join("")}return a;}
function cognitive(a:number){${Array.from<number, string>({ length: 22 }, (_, i) => `if(a===${i + 100})a--;`).join("")}return a;}
function difficulty(a:number){${"a;".repeat(39)}return a;}
function crap(a:number){${Array.from<number, string>({ length: 24 }, (_, i) => `a && (a += ${i + 1});`).join("")}return a;}
console.log(cyclo(0),cognitive(100),difficulty(1),crap(1));`;
    withFixture([{ path: "boundaries.ts", text }], (f) => {
      const out = cli("equality-boundaries", f);
      expect(out.exit).toBe(1);
      const result = out.result();
      expect(named(result, "cyclo").cyclomatic).toBe(22);
      expect(named(result, "cognitive").cognitive).toBe(22);
      expect(named(result, "difficulty").halstead.difficulty).toBe(80);
      expect(named(result, "crap").crap).toBe(25);
      for (const metric of ["cyclomatic", "cognitive", "halsteadDifficulty", "crap"])
        expect(result.findings.some((f) => f.class === metric)).toBe(true);
    });
  }, 60_000);

  test("TSX, methods, constructor, accessor, static, field, namespace, async and generator", () => {
    const text = `const React={createElement:(tag:string,props:object,child:string)=>({tag,props,child})};
class Base { value(){return 1;} }
class A extends Base {
 #n=1;
 static { if(true) console.log("static"); }
 constructor(){super();}
 get n(){return this.#n;}
 set n(v:number){this.#n=v;}
 value(){return super.value()+this.n;}
}
namespace N { export function value(){return 2;} }
async function asyncValue(){return await Promise.resolve(3);}
function* values(){yield 4;}
function view(){return <div data-ok={true}>hello</div>;}
const a=new A();a.n=2;
console.log(a.value(),N.value(),await asyncValue(),values().next().value,view().tag);`;
    withFixture([{ path: "forms.tsx", text }], (f) => {
      expect(f.effects).toEqual(["static\n3 2 3 4 div\n"]);
      const out = cli("typescript-all-forms", f);
      expect(out.exit).toBe(0);
      const result = out.result();
      expect(result.records.some((r) => r.kind === "static" && r.cognitive === 1)).toBe(true);
      expect(result.records.some((r) => r.kind === "field")).toBe(true);
      expect(result.records.some((r) => r.kind === "namespace")).toBe(true);
      expect(named(result, "view").halstead.operands["JsxText:hello"]).toBe(1);
    });
  }, 60_000);

  test("Halstead excludes type syntax and nested headers, includes all literal/operator classes", () => {
    const a = analyzeJavascript(
      source("function f(a:number){ const x:number = a as number; return x; }"),
    );
    const b = analyzeJavascript(source("function f(a){ const x = a; return x; }"));
    expect(a[1]?.halstead).toEqual(b[1]?.halstead);
    const units = analyzeJavascript(
      source(
        `function f(){function nested(x:number){return x+1;} return /a/g.test(\`a\${2}b\`) && 1n !== null;}`,
      ),
    );
    const row = units.find((u) => u.name === "f");
    expect(row?.halstead.operands["RegularExpressionLiteral:/a/g"]).toBe(1);
    expect(row?.halstead.operands["BigIntLiteral:1n"]).toBe(1);
    expect(row?.halstead.operands["NullKeyword:null"]).toBe(1);
    expect(row?.halstead.operands["Identifier:nested"]).toBeUndefined();
    expect(row?.halstead.operators.ExclamationEqualsEqualsToken).toBe(1);
  });

  for (const [name, text, expected] of [
    ["field-arrow", "class A { f=(x:boolean)=> x ? 1:0; } console.log(new A().f(true));", [1, 1]],
    [
      "default-arrow",
      "function f(g=(a:boolean)=>a?1:0){return g(true);} console.log(f());",
      [1, 1],
    ],
  ] as const)
    test(`${name} retains separate executed arrow coverage`, () => {
      // Given: review-R2's exact class-field/default-parameter source.
      withFixture([{ path: "forms.ts", text }], (f) => {
        // When: actual CLI consumes counters from executing that source.
        const out = cli(name, f);
        // Then: the arrow owns its statement and is not absorbed by its parent.
        expect(f.effects).toEqual(["1\n"]);
        expect(out.exit).toBe(0);
        const arrow = out.result().records.find((r) => r.kind === "ArrowFunction");
        expect([arrow?.coverage.hit, arrow?.coverage.total]).toEqual([...expected]);
        expect(arrow?.cyclomatic).toBe(2);
        expect(arrow?.crap).toBe(2);
      });
    }, 60_000);

  for (const decisions of [20, 21])
    test(`Python strict cyclomatic boundary at ${decisions} decisions`, () => {
      // Given: independent sequential-if oracle: C=n+1, cognitive=n.
      const text = `def boundary(x):\n${Array.from<number, string>({ length: decisions }, (_, i) => `    if x == ${i + 1}:\n        x += 1\n`).join("")}    return x\nprint(boundary(1))\n`;
      withFixture([{ path: "boundary.py", text }], (f) => {
        // When: execute and measure with the pinned Python adapter through CLI.
        const out = cli(`python-boundary-${decisions}`, f);
        // Then: only equality at cyclomatic 22 is rejected.
        expect(f.effects).toEqual([`${String(decisions + 1)}\n`]);
        expect(out.exit).toBe(decisions === 21 ? 1 : 0);
        const row = named(out.result(), "boundary");
        expect([row.cyclomatic, row.cognitive, row.crap]).toEqual([
          decisions + 1,
          decisions,
          decisions + 1,
        ]);
        expect(out.result().findings).toEqual(decisions === 21 ? [{ class: "cyclomatic" }] : []);
      });
    }, 60_000);

  test("Python uncovered return remains in the CRAP denominator", () => {
    // Given: only the true branch executes; the false return remains uncovered.
    withFixture(
      [
        {
          path: "partial.py",
          text: "def partial(x):\n    if x:\n        return 1\n    return 0\nprint(partial(True))\n",
        },
      ],
      (f) => {
        // When: consume actual Python statement counters.
        const out = cli("python-uncovered-return", f);
        // Then: 2/3, not definition-line or rounded full coverage.
        expect(out.exit).toBe(0);
        const row = named(out.result(), "partial");
        expect([row.coverage.hit, row.coverage.total]).toEqual([2, 3]);
        expect(row.crap).toBe(4 * (1 - 2 / 3) ** 3 + 2);
      },
    );
  }, 60_000);

  test("real Node-generated original-source counters are consumed", () => {
    withFixture(
      [
        {
          path: "launch.js",
          text: "function f(){return 7;} console.log(f());",
          category: "tooling",
        },
      ],
      (f) => {
        expect(f.effects).toEqual(["7\n"]);
        expect(cli("node-runtime-receipt", f).exit).toBe(0);
      },
      "node",
    );
  }, 60_000);

  test("pinned Python functions, coroutine, generator and lambda run, no host-string credit", () => {
    const text = `import asyncio

def f(x):
    if x:
        return 1
    return 0

async def af():
    return 3

def gen():
    yield 4

inc = lambda x: x + 1
print(f(True) + f(False), asyncio.run(af()), next(gen()), inc(4))
`;
    withFixture([{ path: "driver.py", text }], (f) => {
      expect(f.effects).toEqual(["1 3 4 5\n"]);
      const out = cli("python-runtime-receipt", f);
      expect(out.exit).toBe(0);
      const result = out.result();
      expect(result.records.length).toBe(5);
      expect(named(result, "f").cyclomatic).toBe(2);
      expect(named(result, "f").cognitive).toBe(1);
      expect(named(result, "f").coverage.fraction).toBe(1);
      expect(result.pythonProcesses[0]?.runtime).toBe("3.12.12");
    });
  }, 60_000);

  test("Python class body, unicode locations and method docstrings preserve execution", () => {
    withFixture(
      [
        {
          path: "class.py",
          text: `"""module docs"""
from __future__ import annotations
class A:
    """class docs"""
    if True:
        value = 4
    def f(self):
        """method docs"""
        word = "한글😀"
        return word
print(A().f(), A.value, A.f.__doc__, __doc__)
`,
        },
      ],
      (f) => {
        expect(f.effects).toEqual(["한글😀 4 method docs module docs\n"]);
        const out = cli("python-class-unicode", f);
        expect(out.exit).toBe(0);
        expect(named(out.result(), "A").cognitive).toBe(1);
        expect(named(out.result(), "f").coverage.fraction).toBe(1);
      },
    );
  }, 60_000);

  test("embedded Python and all canonical inventory sections join, then tamper fails", () => {
    const python = "def f(x):\n    return x + 1\nprint(f(2))\n";
    withFixture([{ path: "driver.py", text: python }], (f) => {
      const virtual = "host.ts#PYTHON_DRIVER";
      const hostText = `const PYTHON_DRIVER = String.raw\`${python}\`;\nconsole.log(PYTHON_DRIVER.length);`;
      const host = source(hostText, "host.ts");
      const historical = source("export type H = string;", "history.ts", "historical");
      const hostMap = prepare(host),
        historicalMap = prepare(historical);
      writeFileSync(join(f.root, host.path), hostText);
      writeFileSync(join(f.root, historical.path), historical.text);
      writeFileSync(join(f.root, "migration.sql"), "CREATE TABLE fixture (id INTEGER);\n");
      writeFileSync(join(f.root, "tsconfig.json"), "{}");
      const pyFile = f.receipt.files[0],
        pyProcess = f.receipt.processes[0]?.files[0];
      if (!pyFile || !pyProcess) fail("fixture", "", "missing Python fixture receipt");
      pyFile.path = virtual;
      pyProcess.path = virtual;
      // Python mapHash is source+map+instrumented-code based; virtual path is
      // carried in the source identity, not fabricated host string coverage.
      const extra = [hostMap, historicalMap].map((p) => ({
        path: p.path,
        sha256: p.sha256,
        mapHash: p.mapHash,
        statementMap: p.statementMap,
        fnMap: p.fnMap,
        s: Object.fromEntries(Object.keys(p.statementMap).map((k) => [k, 0])),
        f: Object.fromEntries(Object.keys(p.fnMap).map((k) => [k, 0])),
      }));
      f.receipt.files.push(...extra);
      const inv: Json = {
        version: 1,
        contractHash: f.inventory.contractHash,
        files: [
          {
            path: host.path,
            sha256: host.sha256,
            bytes: host.bytes,
            category: host.category,
            language: host.language,
          },
          {
            path: "migration.sql",
            sha256: sha(readFileSync(join(f.root, "migration.sql"))),
            bytes: readFileSync(join(f.root, "migration.sql")).length,
            category: "migration",
            language: "sql",
          },
        ],
        historical: [
          {
            path: historical.path,
            sha256: historical.sha256,
            bytes: historical.bytes,
            category: "historical",
            language: "typescript",
          },
        ],
        embedded: [
          {
            path: virtual,
            sha256: sha(python),
            bytes: Buffer.byteLength(python),
            category: "production",
            language: "python",
          },
        ],
        configurations: [{ path: "tsconfig.json", sha256: sha("{}") }],
      };
      writeFileSync(f.inventoryPath, JSON.stringify(inv));
      f.receipt.inventoryHash = sha(readFileSync(f.inventoryPath));
      f.save();
      const out = cli("embedded-python-inventory", f);
      expect(out.exit).toBe(0);
      const r = out.result();
      expect([
        r.completeness.files,
        r.completeness.historical,
        r.completeness.embedded,
        r.completeness.configurations,
        r.completeness.measuredSources,
      ]).toEqual([2, 1, 1, 1, 3]);
      expect(r.completeness.nonExecutable.length).toBe(1);
      expect(r.records.find((r) => r.path === virtual && r.name === "f")?.coverage.fraction).toBe(
        1,
      );
      writeFileSync(join(f.root, "tsconfig.json"), '{"changed":true}');
      expect(cli("configuration-tamper", f).exit).toBe(2);
    });
  }, 60_000);

  test("shebang, nested returning arrow and malformed syntax discrimination", () => {
    withFixture(
      [
        {
          path: "bin.js",
          text: "#!/usr/bin/env node\nconst outer=()=>()=>7; console.log(outer()());",
          category: "tooling",
        },
      ],
      (f) => {
        const out = cli("shebang-nested-arrow", f);
        expect(out.exit).toBe(0);
        expect(out.result().records.length).toBe(3);
        expect(out.result().records.every((r) => r.coverage.fraction === 1)).toBe(true);
        const invalid = "function broken( {";
        writeFileSync(join(f.root, "bin.js"), invalid);
        const entry = f.inventory.files[0];
        if (!entry) fail("fixture", "", "missing inventory entry");
        entry.sha256 = sha(invalid);
        entry.bytes = Buffer.byteLength(invalid);
        writeFileSync(f.inventoryPath, JSON.stringify(f.inventory));
        expect(cli("invalid-source-syntax", f).exit).toBe(2);
      },
    );
  }, 60_000);
});

const body = Array.from<number, string>(
  { length: 8 },
  (_, n) => `total += values[${n}] * ${n + 2} + ${n + 3};`,
).join("\n");
function cloneSource(name: string) {
  return `function ${name}(values:number[]){\nlet total=0;\n${body}\nreturn total;\n}\nconsole.log(${name}([1,2,3,4,5,6,7,8]));`;
}
describe("actual jscpd weak50tokens5lines ledgers", () => {
  for (const lines of [4, 5, 6])
    test(`pinned eleven-token rows at ${lines} lines`, async () => {
      // Given: 11 significant tokens per row, independently counted punctuation included.
      const text = "sink(1,2,3,4);\n".repeat(lines);
      // When: use the actual pinned detector, with unchanged minTokens/minLines.
      const out = await detectClones([source(text, "a.ts"), source(text, "b.ts")]);
      // Then: the engine's line-span boundary is preserved, not approximated.
      expect(out.inspected.map((r) => r.tokens)).toEqual([11 * lines, 11 * lines]);
      expect(out.rawEvidence.length).toBe(lines === 6 ? 1 : 0);
      expect(out.clusters.length).toBe(lines === 6 ? 1 : 0);
    });
  test("repeated six-line clone is a real CLI finding, not false clean", () => {
    // Given: two executed 66-token sources, including the engine's truncated B range.
    const text = "console.log(1,2,3);\n".repeat(6);
    withFixture(
      [
        { path: "a.ts", text },
        { path: "b.ts", text },
      ],
      (f) => {
        // When: actual CLI normalizes the pinned detector's evidence.
        const out = cli("repeated-six-line-clone", f);
        // Then: the maximal exact span includes every token in both sources.
        expect(f.effects).toEqual(["1 2 3\n".repeat(6), "1 2 3\n".repeat(6)]);
        expect(out.exit).toBe(1);
        const result = out.result();
        expect(result.findings).toEqual([{ class: "productionDuplication" }]);
        expect(result.duplication.clusters.length).toBe(1);
        expect(result.duplication.clusters[0]?.tokenCount).toBe(66);
        expect(result.duplication.clusters[0]?.occurrences.map((o) => o.path)).toEqual([
          "a.ts",
          "b.ts",
        ]);
      },
    );
  }, 60_000);
  test("comment-only and one-line pairs are not clones", async () => {
    for (const text of [
      "// a\n// b\n// c\n// d\n// e\n",
      "function f(a){if(a)return 1;return 0;}\n",
    ]) {
      const out = await detectClones([source(text, "a.ts"), source(text, "b.ts")]);
      expect(out.clusters.length).toBe(0);
    }
  });
  for (const [name, a, b, expected] of [
    ["production", "production", "production", [1, 0]],
    ["tooling", "tooling", "tooling", [1, 0]],
    ["test", "test", "fixture", [0, 1]],
    ["mixed", "tooling", "benchmark", [1, 1]],
  ] as const)
    test(name, () => {
      withFixture(
        [
          { path: "a.ts", text: cloneSource("first"), category: a },
          { path: "b.ts", text: cloneSource("second"), category: b },
        ],
        (f) => {
          const out = cli(`clone-${name}`, f);
          expect(out.exit).toBe(1);
          const result = out.result();
          expect([
            Number(result.duplication.production > 0),
            Number(result.duplication.test > 0),
          ]).toEqual([...expected]);
          expect(result.duplication.inspected.length).toBe(2);
          expect(
            result.duplication.clusters.every(
              (c) => c.tokenCount >= 50 && c.occurrences.length >= 2,
            ),
          ).toBe(true);
          expect(result.duplication.clusters.every((c) => /^[a-f0-9]{64}$/.test(c.id))).toBe(true);
        },
      );
    }, 60_000);
  test("within-file duplicates and files over the engine's old 500-line default", () => {
    withFixture(
      [
        {
          path: "large.ts",
          text: `${"\n".repeat(510) + cloneSource("first")}\n${cloneSource("second")}`,
        },
      ],
      (f) => {
        const out = cli("clone-within-large-file", f);
        expect(out.exit).toBe(1);
        const d = out.result().duplication;
        expect(d.production).toBeGreaterThan(0);
        expect(d.settings.maxLines).toBeGreaterThan(500);
        expect(d.clusters.some((c) => c.occurrences.every((o) => o.path === "large.ts"))).toBe(
          true,
        );
      },
    );
  }, 60_000);
  test("pinned engine's nonconsecutive B frames normalize to exact equal spans", async () => {
    const block = (a: number, b: number) =>
      Array.from<number, string>(
        { length: b - a },
        (_, n) => `sink(${a + n}, ${a + n + 1}, ${a + n + 2}, ${a + n + 3});`,
      ).join("\n");
    const text =
      block(0, 8) +
      "\nseparator(999);\n" +
      block(3, 13) +
      "\nseparator(888);\n" +
      block(0, 13) +
      "\n";
    const out = await detectClones([source(text, "jump.ts")]);
    expect(
      out.rawEvidence.some(
        (c) =>
          c.duplicationB.range[1] - c.duplicationB.range[0] >
          1.3 * (c.duplicationA.range[1] - c.duplicationA.range[0]),
      ),
    ).toBe(true);
    expect(out.clusters.length).toBe(3);
    for (const cluster of out.clusters) {
      const spans = cluster.occurrences.map((o) => text.slice(o.start, o.end).replace(/\s/g, ""));
      expect(new Set(spans).size).toBe(1);
      expect(cluster.occurrences.every((o) => o.endLine - o.startLine >= 5)).toBe(true);
    }
  });
  test("case-sensitive, stable IDs and Python token format", async () => {
    const a = source(cloneSource("first"), "a.ts"),
      b = source(cloneSource("second"), "b.ts");
    const first = await detectClones([a, b]),
      second = await detectClones([b, a]);
    expect(first.clusters.map((c) => c.id)).toEqual(second.clusters.map((c) => c.id));
    expect(
      (
        await detectClones([
          a,
          source(b.text.replaceAll("total", "TOTAL").replaceAll("values", "VALUES"), "b.ts"),
        ])
      ).clusters.length,
    ).toBe(0);
    const py =
      "def f(values):\n    total = 0\n" +
      Array.from<number, string>(
        { length: 8 },
        (_, n) => `    total += values[${n}] * ${n + 2} + ${n + 3}`,
      ).join("\n") +
      "\n    return total\n";
    expect(
      (await detectClones([source(py, "a.py"), source(py, "b.py")])).production,
    ).toBeGreaterThan(0);
  });
});


test("native instrumentation receipts larger than Bun's default pipe limit stay complete", () => {
  const text = `let value=0;\n${new Array<number>(3000).fill(0).map((_value, index) => `value += ${index};`).join("\n")}\nconsole.log(value);\n`;
  const result = prepare(source(text, "large-source.ts"));
  expect(Object.keys(result.statementMap)).toHaveLength(3002);
  expect(result.code.length).toBeGreaterThan(524288);
});
