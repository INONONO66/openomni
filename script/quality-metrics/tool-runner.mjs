// JSON ABI for pinned analyzers whose public TypeScript result types expose
// top-typed private state. Only validated JSON crosses into owned TS.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// Synchronous lazy imports: importing this module never loads analyzer packages.
const require = createRequire(import.meta.url);
let javascript, coverage;

export function analyze(request) {
  try {
    let result;
    if (request.operation === "javascript") {
      if (!javascript) {
        const { Linter } = require("eslint");
        javascript = {
          linter: new Linter(),
          parser: require("@typescript-eslint/parser"),
          sonar: require("eslint-plugin-sonarjs"),
        };
      }
      const { linter, parser, sonar } = javascript;
      parser.parseForESLint(request.source, {
        filePath: request.path,
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      });
      const config = [
        {
          files: ["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
          languageOptions: {
            parser,
            parserOptions: {
              ecmaVersion: "latest",
              sourceType: "module",
              ecmaFeatures: { jsx: true },
            },
          },
          plugins: { sonarjs: sonar },
          linterOptions: { noInlineConfig: true },
          rules: {
            complexity: ["error", { max: 0, variant: "classic" }],
            "sonarjs/cognitive-complexity": ["error", 0],
          },
        },
      ];
      result = request.wrappers.map((code) =>
        linter.verify(code, config, { filename: request.path }).map((m) => ({
          ruleId: m.ruleId,
          fatal: Boolean(m.fatal),
          line: m.line,
          column: m.column,
          message: m.message,
        })),
      );
    } else if (request.operation === "coverage") {
      if (!coverage) {
        const { createInstrumenter } = require("istanbul-lib-instrument");
        coverage = {
          ...require("@jridgewell/trace-mapping"),
          instrumenter: createInstrumenter({
            coverageVariable: "__d945Coverage",
            coverageGlobalScope: "globalThis",
            coverageGlobalScopeFunc: false,
            esModules: true,
            compact: false,
            preserveComments: false,
            produceSourceMap: false,
            ignoreClassMethods: [],
          }),
        };
      }
      const { instrumenter, TraceMap, originalPositionFor } = coverage;
      const code = instrumenter.instrumentSync(request.code, request.path);
      const raw = instrumenter.lastFileCoverage();
      const trace = new TraceMap(request.sourceMap);
      const position = (p) => {
        const result = originalPositionFor(trace, p);
        if (result.line === null || result.column === null || result.source === null)
          throw new Error(`unmapped generated position ${p.line}:${p.column}`);
        return { line: result.line, column: result.column };
      };
      const range = (r) => ({ start: position(r.start), end: position(r.end) });
      const statementMap = Object.fromEntries(
        Object.entries(raw.statementMap).map(([id, r]) => [id, range(r)]),
      );
      const fnMap = Object.fromEntries(
        Object.entries(raw.fnMap).map(([id, f]) => [
          id,
          { name: f.name, decl: range(f.decl), loc: range(f.loc) },
        ]),
      );
      result = {
        code,
        statementMap,
        fnMap,
        generatedStatements: raw.statementMap,
        generatedFunctions: raw.fnMap,
      };
    } else {
      throw new Error(`unsupported analyzer operation: ${request.operation}`);
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: String(error), stack: error.stack };
  }
}

async function clones(request) {
  const distribution = require("jscpd/package.json");
  if (distribution.version !== "4.0.5") throw new Error("jscpd 4.0.5 is required");
  const { Detector, MemoryStore, weak } = await import("@jscpd/core");
  const { Tokenizer, tokenize } = await import("@jscpd/tokenizer");
  const { createHash } = await import("node:crypto");
  const store = new MemoryStore();
  const detector = new Detector(new Tokenizer(), store, [], {
    ...request.settings,
    mode: weak,
    maxSize: String(request.settings.maxSize),
    hashFunction: (value) => createHash("sha256").update(value).digest("hex"),
  });
  const raw = [],
    tokens = [];
  try {
    for (const source of request.sources) {
      tokens.push({
        path: source.path,
        tokens: tokenize(source.text, source.format).filter(weak),
      });
      raw.push(...(await detector.detect(source.path, source.text, source.format)));
    }
  } finally {
    store.close();
  }
  const nominated = new Set(
    raw.flatMap((clone) => [clone.duplicationA.sourceId, clone.duplicationB.sourceId]),
  );
  // Keep surrounding tokens: repetitive frames can truncate a nominated end.
  // Only nominated seeds are extended, and only while tokens match exactly.
  return {
    raw,
    tokens: tokens.map((row) => ({
      path: row.path,
      count: row.tokens.length,
      tokens: nominated.has(row.path) ? row.tokens : [],
    })),
  };
}

if (import.meta.main) {
  let response;
  try {
    const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
    if (request.operation !== "clones")
      throw new Error(`unsupported analyzer operation: ${request.operation}`);
    response = { ok: true, result: await clones(request) };
  } catch (error) {
    response = { ok: false, message: String(error), stack: error.stack };
    process.exitCode = 2;
  }
  writeFileSync(process.argv[3], `${JSON.stringify(response)}\n`, { flag: "wx" });
}
