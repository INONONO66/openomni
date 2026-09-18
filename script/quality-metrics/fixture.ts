import { copyFileSync, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepare, type Counters } from "./coverage";
import { analyzePython } from "./python";
import { sha, decode, object, array, integer, fail, type Json, type Source } from "./input";

const collector = join(import.meta.dir, "../quality-coverage/python.py");
type Spawned = { exitCode: number; pid: number; stdout: Buffer; stderr: Buffer };
/** Python counters come from the exact collector's own `run` mode, so the
 * fixture exercises the single map owner instead of a second instrumenter. */
function runPythonCollector(root: string, source: Source, index: number): { child: Spawned; counts: () => Counters } {
  const python = Bun.env.D945_PYTHON ?? "python3";
  const prepared = Bun.spawnSync([python, collector, "prepare"], {
    cwd: root, stdin: Buffer.from(JSON.stringify({ path: source.path, source: source.text })),
    stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  if (prepared.exitCode !== 0)
    fail("fixture", source.path, `collector prepare failed: ${String(prepared.stderr)}`);
  const model = object(decode(prepared.stdout.toString()));
  const coverage = object(model.coverage);
  const branchSlots = Object.values(object(coverage.b)).map((zeros) => array(zeros).length);
  const lineOffset = Object.keys(object(coverage.s)).length + Object.keys(object(coverage.f)).length
    + branchSlots.reduce((sum: number, n) => sum + n, 0);
  const slots = lineOffset + array(model.lines).length;
  const directory = join(root, `collector-${index}`);
  mkdirSync(directory);
  writeFileSync(join(directory, "python-files.json"), JSON.stringify([{
    path: source.path, source: source.text, coverage, lines: model.lines, arcs: model.arcs, offset: 0, lineOffset,
  }]));
  writeFileSync(join(directory, "process-size.json"), JSON.stringify({ slots }));
  const env = { ...process.env };
  delete env.D945_SOURCE_ROOT;
  delete env.D945_PARENT;
  // Like production (`launchCommand`), the driver runs from a copy outside the frozen
  // root: under an outer exact collector it is then an external program, not a nested
  // Runner competing for the same sys.monitoring tool id.
  const driver = join(directory, "python.py");
  copyFileSync(collector, driver);
  const child = spawn([python, "-u", driver, "run", directory, `process-${index}`, source.path], root, env);
  return { child, counts: () => pythonCounts(join(directory, `process-${index}.counts.bin`), coverage) };
}
function spawn(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Spawned {
  const child = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { exitCode: child.exitCode, pid: child.pid, stdout: Buffer.from(child.stdout ?? ""), stderr: Buffer.from(child.stderr ?? "") };
}
/** counts.bin is one little-endian double per slot: statements, then functions, then branches and lines. */
function pythonCounts(path: string, coverage: { [key: string]: Json }): Counters {
  const counts = readFileSync(path);
  let slot = 0;
  const next = () => integer(counts.readDoubleLE(8 * slot++));
  const s = Object.fromEntries(Object.keys(object(coverage.s)).map((id) => [id, next()]));
  const f = Object.fromEntries(Object.keys(object(coverage.f)).map((id) => [id, next()]));
  return { s, f };
}

export type FixtureSource = { path: string; text: string; category?: string; language?: string };
export function makeFixture(inputs: FixtureSource[], engine: "bun" | "node" = "bun") {
  const root = mkdtempSync(join(tmpdir(), "d945-metrics-"));
  let complete = false;
  try {
    const sources: Source[] = inputs.map((input) => ({
      path: input.path,
      text: input.text,
      category: input.category ?? "production",
      language:
        input.language ??
        (input.path.endsWith(".py")
          ? "python"
          : input.path.endsWith(".js")
            ? "javascript"
            : "typescript"),
      sha256: sha(input.text),
      bytes: Buffer.byteLength(input.text),
    }));
    for (const source of sources) {
      mkdirSync(dirname(join(root, source.path)), { recursive: true });
      writeFileSync(join(root, source.path), source.text);
    }
    const inventory = {
      version: 1,
      contractHash: sha("d945-fixture-contract"),
      files: sources.map((s) => ({
        path: s.path,
        sha256: s.sha256,
        bytes: s.bytes,
        category: s.category,
        language: s.language,
      })),
      historical: [],
      embedded: [],
      configurations: [],
    };
    const inventoryPath = join(root, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    const prepared = sources.map((source) =>
      source.language === "python" ? analyzePython(source).prepared : prepare(source),
    );
    const receipts: {
      id: string;
      parent: string;
      children: string[];
      exitCode: number;
      completed: boolean;
      files: (Counters & { path: string; sha256: string; mapHash: string })[];
    }[] = [];
    const effects: string[] = [];
    const processEvidence: {
      pid: number;
      executable: string;
      status: number;
      stdout: string;
      stderr: string;
    }[] = [];
    for (const [index, p] of prepared.entries()) {
      const source = sources[index];
      if (!source) fail("fixture", "", "fixture source absent");
      const python = source.language === "python";
      const output = join(root, `counters-${index}.json`);
      const entry = join(root, `instrumented-${index}.mjs`);
      const executable = python
        ? (Bun.env.D945_PYTHON ?? "python3")
        : engine === "node"
          ? "node"
          : process.execPath;
      let child: Spawned;
      let collected: (() => Counters) | undefined;
      if (python) {
        ({ child, counts: collected } = runPythonCollector(root, source, index));
      } else {
        writeFileSync(entry, `${p.code}\nimport {writeFileSync as __d945write} from "node:fs";\n__d945write(${JSON.stringify(output)},JSON.stringify({s:globalThis.__d945Coverage[${JSON.stringify(p.path)}].s,f:globalThis.__d945Coverage[${JSON.stringify(p.path)}].f}));\n`);
        child = spawn([executable, entry], root);
      }
      if (child.exitCode !== 0)
        fail("fixture", source.path, `fixture process failed: ${child.stderr.toString()}`);
      const counts = collected ? collected() : (() => {
        const raw = object(decode(readFileSync(output, "utf8")));
        return {
          s: Object.fromEntries(Object.entries(object(raw.s)).map(([id, n]) => [id, integer(n)])),
          f: Object.fromEntries(Object.entries(object(raw.f)).map(([id, n]) => [id, integer(n)])),
        };
      })();
      receipts.push({
        id: `process-${index}`,
        parent: "",
        children: [],
        exitCode: child.exitCode,
        completed: true,
        files: [{ path: p.path, sha256: p.sha256, mapHash: p.mapHash, ...counts }],
      });
      effects.push(child.stdout.toString());
      processEvidence.push({
        pid: child.pid,
        executable,
        status: child.exitCode,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString(),
      });
    }
    const files = prepared.map((p, i) => {
      const counters = receipts[i]?.files[0];
      if (!counters) fail("fixture", "", "missing fixture process counters");
      return {
        path: p.path,
        sha256: p.sha256,
        mapHash: p.mapHash,
        statementMap: p.statementMap,
        fnMap: p.fnMap,
        s: counters.s,
        f: counters.f,
      };
    });
    const receipt = {
      version: 2,
      complete: true,
      inventoryHash: sha(readFileSync(inventoryPath)),
      contractHash: inventory.contractHash,
      run: {
        id: "fixture-run",
        head: sha("fixture-head"),
        tree: sha(JSON.stringify(sources.map((s) => [s.path, s.sha256]))),
      },
      roots: receipts.map((r) => r.id),
      processes: receipts,
      files,
    };
    const coveragePath = join(root, "coverage.json");
    writeFileSync(coveragePath, JSON.stringify(receipt));
    complete = true;
    return {
      root,
      sources,
      prepared,
      inventory,
      inventoryPath,
      coveragePath,
      receipt,
      effects,
      processEvidence,
      save() {
        writeFileSync(coveragePath, JSON.stringify(receipt));
      },
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    };
  } finally {
    if (!complete) rmSync(root, { recursive: true, force: true });
  }
}
