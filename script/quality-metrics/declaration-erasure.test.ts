import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { observeFixture } from "./fixture-observation";
import { array, fail, object } from "./input";

const receipts: string[] = [];
const boundary = (property: string, result = "g.x") =>
  `function boundary(){class G{x${property};constructor(){this.x=2;}} const g=new G();${"g.x;".repeat(18)}return ${result};} console.log(boundary());`;

function observe(name: string, source: string, effect: string) {
  const observation = observeFixture(source, effect, name, receipts);
  const { result, emitted, exit } = observation;
  expect(result.complete).toBe(true);
  expect(result.exitCode).toBe(exit);
  const rows = array(result.records).map(object);
  const row = rows.find((row) => row.name === "boundary");
  if (!row) fail("fixture", name, "boundary unit absent");
  return { result, rows, row, h: object(row.halstead), emitted, exit };
}

function equalPair(name: string, sources: readonly string[], effect = "2\n") {
  const observations = sources.map((source) => observe(name, source, effect));
  const [plain, marked] = observations;
  if (!plain || !marked) fail("fixture", name, "pair incomplete");
  expect(marked.emitted).toBe(plain.emitted);
  // Source ranges and coverage-map hashes must differ; executable token maps must not.
  expect(marked.rows.map((row) => row.halstead)).toEqual(plain.rows.map((row) => row.halstead));
  expect(marked.exit).toBe(plain.exit);
  expect(marked.result.findings).toEqual(plain.result.findings);
  return observations;
}

test("R5 exact REVIEW-R4 optional-property gate pair", () => {
  const observations = equalPair("review-r4", [boundary(":number"), boundary("?:number")]);
  for (const { h, row, result, exit } of observations) {
    expect([h.n1, h.n2, h.N1, h.N2, h.difficulty]).toEqual([11, 3, 51, 42, 77]);
    expect(object(h.operators).QuestionToken).toBeUndefined();
    expect(row).toMatchObject({ cyclomatic: 1, cognitive: 0, crap: 1 });
    expect(object(row.coverage)).toMatchObject({ hit: 20, total: 20, fraction: 1 });
    expect(result.findings).toEqual([]);
    expect(exit).toBe(0);
  }
}, 60_000);

const declarationPairs = [
  ["optional-trivia", [":number", " /*before*/ ? /*after*/ :number"].map((p) => boundary(p))],
  [
    "definite-siblings",
    ["let x:number,y:number", "let x!:number,y!:number"].map(
      (decl) => `function boundary(){${decl};x=1;y=1;return x+y;} console.log(boundary());`,
    ),
  ],
  ...["public", "private", "protected", "readonly", "public readonly"].map(
    (modifier) =>
      [
        modifier,
        ["", `${modifier} `].map(
          (m) =>
            `function boundary(){class G{${m}x:number=1+1;read(){return this.x;}}return new G().read();} console.log(boundary());`,
        ),
      ] as const,
  ),
  [
    "override",
    ["", "override "].map(
      (m) =>
        `function boundary(){class B{x=1;}class G extends B{${m}x=2;}return new G().x;} console.log(boundary());`,
    ),
  ],
  [
    "abstract-class",
    ["", "abstract "].map(
      (m) =>
        `function boundary(){${m}class B{}class G extends B{x=2;}return new G().x;} console.log(boundary());`,
    ),
  ],
  ...(
    [
      ["abstract-field", "abstract x:number;"],
      ["abstract-method", "abstract read<T>(x?:T):T;"],
      ["abstract-accessor", "abstract get value():number;"],
      ["declare-field", "declare x:number;"],
      ["index-signature", "readonly [key:string]:number;"],
    ] as const
  ).map(
    ([name, member]) =>
      [
        name,
        ["", member].map(
          (m) => `function boundary(){abstract class B{${m}}return 2;} console.log(boundary());`,
        ),
      ] as const,
  ),
  [
    "ambient-declarations",
    [
      "",
      "declare const absent:number;declare class Ghost{x:number;}declare function phantom<T>(x?:T):T;",
    ].map((decl) => `${decl}function boundary(){return 2;} console.log(boundary());`),
  ],
  [
    "overload-signature",
    ["", "function read<T>(x?:T):T;\n"].map(
      (decl) =>
        `function boundary(){\n${decl}function read(x=2){return x;}\nreturn read();\n} console.log(boundary());`,
    ),
  ],
  [
    "generic-annotations",
    ["", "< /*left*/ const T extends number = number, /*right*/ >"].map(
      (types) =>
        `function boundary(){class G${types}{x:Readonly<number>=2;}return new G().x;} console.log(boundary());`,
    ),
  ],
  [
    "variance-parameters",
    ["", "<in out T>"].map(
      (types) =>
        `function boundary(){class G${types}{x=2;}return new G().x;} console.log(boundary());`,
    ),
  ],
  [
    "function-headers",
    ["function read(x=2)", "function read<T>(x:number=2):number"].map(
      (header) =>
        `function boundary(){${header}{return x;}return read();} console.log(boundary());`,
    ),
  ],
  [
    "optional-method",
    ["read()", "read?():number"].map(
      (header) =>
        `function boundary(){class G{${header}{return 2;}}return new G().read();} console.log(boundary());`,
    ),
  ],
  [
    "annotated-initializer",
    ["", ": /*type*/ Readonly<number>"].map(
      (type) => `function boundary(){const x${type}=1+1;return x;} console.log(boundary());`,
    ),
  ],
] as const;

for (const [name, sources] of declarationPairs) {
  test(`R5 declaration taxonomy: ${name}`, () => {
    for (const observation of equalPair(name, sources)) {
      expect(observation.exit).toBe(0);
      expect(observation.result.findings).toEqual([]);
    }
  }, 60_000);
}

for (const [name, expression, effect, counts, operators, cyclomatic, cognitive] of [
  ["optional-chain", "g?.x", "2\n", [12, 3, 51, 42, 84], { QuestionDotToken: 1 }, 2, 0],
  [
    "ternary",
    "g.x ? 0 : g.x",
    "0\n",
    [13, 4, 54, 45, 73.125],
    { QuestionToken: 1, ColonToken: 1 },
    2,
    1,
  ],
  ["logical-not", "!g.x", "false\n", [12, 3, 52, 42, 84], { ExclamationToken: 1 }, 1, 0],
] as const) {
  test(`R5 retains executable ${name}`, () => {
    const plain = observe(`${name}-plain`, boundary(":number"), "2\n");
    const runtime = equalPair(
      name,
      [boundary(":number", expression), boundary("?:number", expression)],
      effect,
    );
    for (const observation of runtime) {
      expect(observation.emitted).not.toBe(plain.emitted);
      expect(observation.h).not.toEqual(plain.h);
      const { h, row, result, exit } = observation;
      expect([h.n1, h.n2, h.N1, h.N2, h.difficulty]).toEqual([...counts]);
      expect(object(h.operators)).toMatchObject(operators);
      expect(row).toMatchObject({ cyclomatic, cognitive, crap: cyclomatic });
      expect(object(row.coverage)).toMatchObject({ hit: 20, total: 20, fraction: 1 });
      expect(exit).toBe(counts[4] >= 80 ? 1 : 0);
      expect(result.findings).toEqual(
        counts[4] >= 80
          ? [{ class: "halsteadDifficulty", path: "boundary.ts", start: 0, value: counts[4] }]
          : [],
      );
    }
  }, 60_000);
}

test("R5 retains static, initializers, operators and keyword property names", () => {
  const observations = ["+", "*"].map((operator) =>
    observe(
      `initializer-${operator}`,
      `function boundary(){class G{static readonly readonly:number=2${operator}2;}return G.readonly;} console.log(boundary());`,
      "4\n",
    ),
  );
  const [plus, multiply] = observations;
  if (!plus || !multiply) fail("fixture", "initializer", "pair incomplete");
  expect(plus.emitted).not.toBe(multiply.emitted);
  expect(plus.rows.map((row) => row.halstead)).not.toEqual(
    multiply.rows.map((row) => row.halstead),
  );
  for (const [index, observation] of observations.entries()) {
    expect(object(observation.h.operators).StaticKeyword).toBe(1);
    expect(object(observation.h.operators).FirstAssignment).toBe(1);
    expect(object(observation.h.operators).ReadonlyKeyword).toBeUndefined();
    expect(object(observation.h.operands)["Identifier:readonly"]).toBe(2);
    const field = observation.rows.find((row) => row.kind === "field");
    if (!field) fail("fixture", "initializer", "field unit absent");
    expect(object(object(field.halstead).operators)).toEqual(
      index === 0 ? { PlusToken: 1 } : { AsteriskToken: 1 },
    );
    expect(object(object(field.halstead).operands)).toEqual({ "FirstLiteralToken:2": 2 });
    expect(observation.exit).toBe(0);
  }
}, 60_000);

afterAll(() => {
  if (Bun.env.D945_R5_RECEIPT)
    writeFileSync(Bun.env.D945_R5_RECEIPT, `[\n${receipts.join(",\n")}\n]\n`);
});
