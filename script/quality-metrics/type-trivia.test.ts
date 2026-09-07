import { afterAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { makeFixture } from "./fixture";
import { invokeFixture, observeFixture } from "./fixture-observation";
import { array, decode, fail, object, sha } from "./input";

const receipts: string[] = [];
const cases = [
  ...[
    ["bare", "g(1)"],
    ["tight", "g<number>(1)"],
    ["right-space", "g<number >(1)"],
    ["left-space", "g< number>(1)"],
    ["both-comments", "g /*before*/ < /*left*/ number /*right*/ > /*after*/ (1)"],
    ["newlines", "g<\nnumber\n>(1)"],
    ["nested-type", "g<Readonly<Array<number>>[number] >(1)"],
    ["trailing-comma", "g<number, >(1)"],
  ].map(([name, call]) => ({
    name: `boundary-${name}`,
    text: `function g<T>(x:T){return x;}\nfunction boundary(){return ${new Array(20).fill(call).join("+")};}\nconsole.log(boundary());`,
    effect: "20\n",
    expected: { n1: 7, n2: 2, N1: 63, N2: 40, difficulty: 70 },
  })),
  ...["", "<number>", "< /*left*/ number /*right*/ >"].flatMap((types, index) => [
    {
      name: `constructor-${index}`,
      text: `class G<T>{constructor(public value:T){}} function boundary(){return new G${types}(1).value;} console.log(boundary());`,
      effect: "1\n",
      expected: { n1: 8, n2: 3, N1: 8, N2: 3, difficulty: 4 },
    },
    {
      name: `tag-${index}`,
      text: `function tag<T>(s:TemplateStringsArray){return s[0];} function boundary(){return tag${types}\`x\`;} console.log(boundary());`,
      effect: "x\n",
      expected: { n1: 4, n2: 2, N1: 4, N2: 2, difficulty: 2 },
    },
    {
      name: `instantiation-${index}`,
      text: `function g<T>(x:T){return x;} function boundary(){const f=g${types};return f(1);} console.log(boundary());`,
      effect: "1\n",
      expected: { n1: 8, n2: 3, N1: 9, N2: 4, difficulty: 16 / 3 },
    },
  ]),
  ...["", ":number", ": /*type*/ number"].map((type, index) => ({
    name: `annotation-${index}`,
    text: `function boundary(){const x${type}=1;return x;} console.log(boundary());`,
    effect: "1\n",
    expected: { n1: 6, n2: 2, N1: 7, N2: 3, difficulty: 4.5 },
  })),
  ...["", "<T>", "< /*left*/ T extends number = number /*right*/ >"].map((types, index) => ({
    name: `class-parameters-${index}`,
    text: `function boundary(){class G${types}{} return 1;} console.log(boundary());`,
    effect: "1\n",
    expected: { n1: 5, n2: 2, N1: 7, N2: 2, difficulty: 2.5 },
  })),
  ...["", "<number>", "< /*left*/ number /*right*/ >"].map((types, index) => ({
    name: `heritage-${index}`,
    text: `class G<T>{} function boundary(){class D extends G${types}{} return 1;} console.log(boundary());`,
    effect: "1\n",
    expected: { n1: 6, n2: 3, N1: 8, N2: 3, difficulty: 3 },
  })),
  {
    name: "executable-comparisons",
    text: "function boundary(a:number,b:number){return a < b && b > a;} console.log(boundary(1,2));",
    effect: "true\n",
    expected: { n1: 7, n2: 2, N1: 7, N2: 4, difficulty: 7 },
  },
];

for (const scenario of cases) {
  test(`preserves exact executable Halstead when ${scenario.name}`, () => {
    // Given: original bytes, complete maps, and counters from real execution.
    const fixture = makeFixture([{ path: "boundary.ts", text: scenario.text }]);
    try {
      // When: invoke the actual source entry (or its explicitly selected bundle).
      const child = invokeFixture(fixture);
      const stdout = child.stdout.toString(),
        stderr = child.stderr.toString();
      receipts.push(
        JSON.stringify({
          case: scenario.name,
          source: scenario.text,
          sourceHash: sha(scenario.text),
          expected: scenario.expected,
          expectedEffect: scenario.effect,
          effects: fixture.effects,
          inventory: fixture.inventory,
          coverage: fixture.receipt,
          fixtureProcesses: fixture.processEvidence,
          cliPid: child.pid,
          exit: child.exitCode,
          stdout,
          stderr,
        }),
      );
      // Then: the oracle counts executable tokens, never the analyzer output.
      expect(fixture.effects).toEqual([scenario.effect]);
      const result = object(decode(stdout));
      const row = array(result.records)
        .map(object)
        .find((row) => row.name === "boundary");
      if (!row) fail("fixture", scenario.name, "boundary unit absent");
      expect(row.halstead).toMatchObject(scenario.expected);
      expect(child.exitCode).toBe(scenario.name === "boundary-newlines" ? 1 : 0);
      expect(stderr).toBe("");
      // Repeated multiline calls also satisfy the frozen clone unit. Keep that finding.
      expect(array(result.findings).map((finding) => object(finding).class)).toEqual(
        scenario.name === "boundary-newlines" ? ["productionDuplication"] : [],
      );
      expect(row.cyclomatic).toBe(scenario.name === "executable-comparisons" ? 2 : 1);
      expect(row.cognitive).toBe(scenario.name === "executable-comparisons" ? 1 : 0);
      expect(object(row.coverage).fraction).toBe(1);
      expect(row.crap).toBe(scenario.name === "executable-comparisons" ? 2 : 1);
      const operators = object(object(row.halstead).operators);
      expect(operators.FirstBinaryOperator).toBe(
        scenario.name === "executable-comparisons" ? 1 : undefined,
      );
      expect(operators.GreaterThanToken).toBe(
        scenario.name === "executable-comparisons" ? 1 : undefined,
      );
    } finally {
      fixture.cleanup();
      receipts.push(JSON.stringify({ case: scenario.name, cleanup: !existsSync(fixture.root) }));
    }
  }, 60_000);
}

// Each pair is an independently executable spelling of the same runtime program.
// The exact reviewer counts anchor the oracle; the other pairs mutate syntax,
// names, literals and declaration locations rather than copying analyzer logic.
const markerPairs = [
  ...[42, 43].map((repeats) => ({
    name: `declaration-${repeats}`,
    sources: [":number", "!:number"].map(
      (type) =>
        `function boundary(){let x${type};x=1;${"x;".repeat(repeats)}return x;} console.log(boundary());`,
    ),
    effect: "1\n",
    counts: [6, 2, repeats + 8, repeats + 4, (3 * (repeats + 4)) / 2],
    statements: repeats + 2,
    negations: 0,
  })),
  ...(
    [
      ["nonnull-call", "g(1)", "g!(1)", "20\n", 0],
      ["nonnull-trivia", "g(1)", "g /*before*/ ! /*after*/ (1)", "20\n", 0],
      ["nonnull-chain", "g(1)", "g!!(1)", "20\n", 0],
      ["logical-not", "!g(1)", "!g!(1)", "0\n", 20],
      ["double-logical-not", "!!g(1)", "!!g!(1)", "20\n", 40],
    ] as const
  ).map(([name, plain, marked, effect, negations]) => ({
    name,
    sources: [plain, marked].map(
      (call) =>
        `function g<T>(x:T){return x;}\nfunction boundary(){return ${Array.from({ length: 20 }, () => call).join("+")};}\nconsole.log(boundary());`,
    ),
    effect,
    counts: [negations ? 8 : 7, 2, 63 + negations, 40, negations ? 80 : 70],
    statements: 1,
    negations,
  })),
  {
    name: "property-definite",
    sources: [":number", " /*before*/ ! /*after*/ :number"].map(
      (type) =>
        `function boundary(){class G{x${type};constructor(){this.x=2;}} const g=new G();return g.x;} console.log(boundary());`,
    ),
    effect: "2\n",
    counts: undefined,
    statements: 2,
    negations: 0,
  },
  {
    name: "initialized-variable",
    sources: ["", " /*type*/ !"].map(
      (marker) =>
        `function boundary(){let value:number=2${marker};return value;} console.log(boundary());`,
    ),
    effect: "2\n",
    counts: [6, 2, 7, 3, 4.5],
    statements: 2,
    negations: 0,
  },
  {
    name: "initialized-property",
    sources: ["", "!"].map(
      (marker) =>
        `function boundary(){class G{x:number=2${marker};} const g=new G();return g.x;} console.log(boundary());`,
    ),
    effect: "2\n",
    counts: undefined,
    statements: 2,
    negations: 0,
  },
];

for (const pair of markerPairs) {
  test(`R4 erased markers preserve runtime tokens and gate: ${pair.name}`, () => {
    const observations = pair.sources.map((source) => observeFixture(source, pair.effect, pair.name, receipts));
    const [plain, marked] = observations;
    if (!plain || !marked) fail("fixture", String(pair.name), "pair incomplete");
    expect(marked.emitted).toBe(plain.emitted);
    const plainRows = array(plain.result.records).map(object),
      markedRows = array(marked.result.records).map(object);
    // Compare every unit, including separately owned initialized fields.
    expect(markedRows.map((row) => row.halstead)).toEqual(plainRows.map((row) => row.halstead));
    for (const observation of observations) {
      const row = array(observation.result.records)
        .map(object)
        .find((row) => row.name === "boundary");
      if (!row) fail("fixture", String(pair.name), "boundary unit absent");
      const h = object(row.halstead);
      if (pair.counts) expect([h.n1, h.n2, h.N1, h.N2, h.difficulty]).toEqual(pair.counts);
      expect(object(h.operators).ExclamationToken).toBe(pair.negations || undefined);
      expect(row.cyclomatic).toBe(1);
      expect(row.cognitive).toBe(0);
      expect(row.crap).toBe(1);
      expect(object(row.coverage)).toMatchObject({
        hit: pair.statements,
        total: pair.statements,
        fraction: 1,
      });
      const findings = pair.negations
        ? [{ class: "halsteadDifficulty", path: "boundary.ts", start: 30, value: 80 }]
        : [];
      expect(observation.result.findings).toEqual(findings);
      expect(observation.exit).toBe(pair.negations ? 1 : 0);
      expect(observation.result.exitCode).toBe(observation.exit);
      expect(observation.result.complete).toBe(true);
    }
  }, 60_000);
}

afterAll(() => {
  if (Bun.env.D945_R3_RECEIPT)
    writeFileSync(Bun.env.D945_R3_RECEIPT, `[\n${receipts.join(",\n")}\n]\n`);
});
