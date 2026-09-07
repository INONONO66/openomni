import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeJavascript } from "./quality-metrics/javascript";
import { analyzePython } from "./quality-metrics/python";
import { detectClones } from "./quality-metrics/clones";
import { joinCoverage, loadCoverage, prepare } from "./quality-metrics/coverage";
import { fail, loadInventory, MetricsError, toolVersion } from "./quality-metrics/input";
import { toolReceipts } from "./quality-metrics/tool";

export async function run(argv = Bun.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: process.cwd() },
      inventory: { type: "string" },
      coverage: { type: "string" },
      contract: { type: "string" },
      plan: { type: "string" },
    },
    strict: true,
  });
  if (!values.inventory) fail("input", "", "--inventory is required");
  if (!values.coverage) fail("coverage", "", "--coverage is required for CRAP");
  if (!["1.3.6", "1.4.1"].includes(Bun.version))
    fail("toolchain", "", "Bun 1.3.6 or explicit 1.4.1 compatibility runtime required");
  const tools = [
    toolVersion("typescript", "5.9.2"),
    toolVersion("eslint", "9.36.0"),
    toolVersion("@typescript-eslint/parser", "8.44.0"),
    toolVersion("eslint-plugin-sonarjs", "3.0.5"),
    // D945 invokes the distribution's core/tokenizer API, not its finder CLI.
    toolVersion("jscpd", "4.0.5"),
    toolVersion("@jscpd/core", "4.0.1"),
    toolVersion("@jscpd/tokenizer", "4.0.1"),
    toolVersion("istanbul-lib-instrument", "6.0.3"),
  ];
  const inventory = loadInventory(resolve(values.root), resolve(values.inventory));
  const sources = [...inventory.files, ...inventory.embedded, ...inventory.historical];
  const executable = sources.filter((s) => s.language !== "sql");
  const analyzed = executable.map((source) => {
    if (source.language === "python") return { source, ...analyzePython(source) };
    return { source, units: analyzeJavascript(source), prepared: prepare(source), receipt: null };
  });
  const coverage = loadCoverage(
    resolve(values.coverage),
    inventory,
    analyzed.map((a) => a.prepared),
    values.contract && values.plan ? { root: resolve(values.root), inventory: resolve(values.inventory), contract: resolve(values.contract), plan: resolve(values.plan) } : undefined,
  );
  const records = analyzed.flatMap((a) => {
    const counters = coverage.totals.get(a.source.path);
    if (!counters) fail("coverage", a.source.path, "missing source counters");
    return joinCoverage(a.source, a.units, a.prepared, counters);
  });
  const duplication = await detectClones(executable);
  const findings: { class: string; path: string; start: number; value: number }[] = [];
  for (const record of records) {
    for (const [metric, value, limit] of [
      ["cyclomatic", record.cyclomatic, 22],
      ["cognitive", record.cognitive, 22],
      ["halsteadDifficulty", record.halstead.difficulty, 80],
      ["crap", record.crap, 25],
    ] as const)
      if (value >= limit)
        findings.push({ class: metric, path: record.path, start: record.start, value });
  }
  for (const partition of ["production", "test"] as const) {
    if (duplication[partition])
      findings.push({
        class: `${partition}Duplication`,
        path: "",
        start: 0,
        value: duplication[partition],
      });
  }
  return {
    version: 2,
    complete: true,
    exitCode: findings.length ? 1 : 0,
    inventoryHash: inventory.inventoryHash,
    contractHash: inventory.contractHash,
    runtime: { bun: Bun.version, authoritative: Bun.version === "1.3.6" },
    tools,
    coverage: {
      run: coverage.run,
      receiptHash: coverage.receiptHash,
      processes: coverage.processes,
    },
    analyzerProcesses: toolReceipts(),
    pythonProcesses: analyzed.flatMap((a) => (a.receipt ? [a.receipt] : [])),
    completeness: {
      files: inventory.files.length,
      historical: inventory.historical.length,
      embedded: inventory.embedded.length,
      configurations: inventory.configurations.length,
      measuredSources: executable.length,
      units: records.length,
      nonExecutable: sources
        .filter((s) => s.language === "sql")
        .map((s) => ({
          path: s.path,
          sha256: s.sha256,
          reason: "SQL migration inventory: outside D945 function/clone language set",
        })),
    },
    thresholds: { cyclomatic: "<22", cognitive: "<22", halsteadDifficulty: "<80", crap: "<25" },
    records,
    max: {
      cyclomatic: Math.max(0, ...records.map((r) => r.cyclomatic)),
      cognitive: Math.max(0, ...records.map((r) => r.cognitive)),
      halsteadDifficulty: Math.max(0, ...records.map((r) => r.halstead.difficulty)),
      crap: Math.max(0, ...records.map((r) => r.crap)),
    },
    duplication,
    findings,
  };
}
if (import.meta.main) {
  await run().then(
    (result) => {
      console.log(JSON.stringify(result));
      process.exitCode = result.exitCode;
    },
    (error: { message: string; stack?: string }) => {
      console.error(
        JSON.stringify({
          code: error instanceof MetricsError ? error.code : "analyzer",
          path: error instanceof MetricsError ? error.path : "",
          message: error.message,
          stack: error.stack,
          complete: false,
        }),
      );
      process.exitCode = 2;
    },
  );
}
