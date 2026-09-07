import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepare, type Counters } from "./coverage";
import { analyzePython } from "./python";
import { sha, decode, object, integer, fail, type Source } from "./input";

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
      const entry = join(root, `instrumented-${index}.${python ? "py" : "mjs"}`);
      const code = python
        ? p.code
        : `${p.code}\nimport {writeFileSync as __d945write} from "node:fs";\n__d945write(${JSON.stringify(output)},JSON.stringify({s:globalThis.__d945Coverage[${JSON.stringify(p.path)}].s,f:globalThis.__d945Coverage[${JSON.stringify(p.path)}].f}));\n`;
      writeFileSync(entry, code);
      const executable = python
        ? (Bun.env.D945_PYTHON ?? "python3")
        : engine === "node"
          ? "node"
          : process.execPath;
      const child = Bun.spawnSync([executable, entry], {
        cwd: root,
        env: { ...process.env, D945_PY_COUNTERS: output },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      if (child.exitCode !== 0)
        fail("fixture", entry, `fixture process failed: ${child.stderr.toString()}`);
      const raw = object(decode(readFileSync(output, "utf8")));
      const counts = {
        s: Object.fromEntries(Object.entries(object(raw.s)).map(([id, n]) => [id, integer(n)])),
        f: Object.fromEntries(Object.entries(object(raw.f)).map(([id, n]) => [id, integer(n)])),
      };
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
