import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fingerprint, recordObject } from "./quality-ci-input";
import { digest } from "./quality-inventory";
import { parseNativeLcov } from "./quality-native-lcov";

export function collectExactFixture(options: {
  root: string; contract: string; directory: string; plan: string; run: string;
}, commands = [{ id: "entry", kind: "cli", paths: ["script/a.ts"], args: [], expectedExitCode: 0 }]) {
  const identity = fingerprint(options.root, options.contract);
  mkdirSync(options.directory, { recursive: true });
  const inventory = join(options.directory, "exact.inventory.json");
  const plan = join(options.directory, "exact.plan.json");
  const coverage = join(options.directory, "exact.coverage.json");
  writeFileSync(inventory, JSON.stringify(identity.inventory));
  writeFileSync(plan, JSON.stringify({ version: 2, commands, faults: [], run: { id: options.run, selectionHash: digest(readFileSync(options.plan)) } }));
  const paths = { contract: resolve(options.root, options.contract), inventory, plan };
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "check-quality-coverage.ts"), "--root", options.root,
    ...Object.entries(paths).flatMap(([key, path]) => [`--${key}`, path, `--${key}-sha256`, digest(readFileSync(path))]),
    "--collect", "--write-coverage", coverage,
  ], { cwd: options.root, timeout: 120_000 });
  // A genuine uncovered result (1) is complete evidence, not an analyzer error (2).
  if (![0, 1].includes(child.exitCode)) throw new Error(`exact fixture failed: ${child.stdout.toString()} ${child.stderr.toString()}`);
  if (recordObject(coverage).version !== 1 || fingerprint(options.root, options.contract).inventoryHash !== identity.inventoryHash)
    throw new Error("exact fixture changed its frozen inputs");
  writeFileSync(`${coverage}.sha256`, digest(readFileSync(coverage)));
  return identity;
}

export function coverageLaneFixture(root: string, hits: number) {
  const target = "packages/machines/src/a.ts", anchor = "script/anchor.ts", run = "native-run";
  const identity = { paths: [target, anchor], typescript: [target, anchor], inventoryHash: "a".repeat(64), contractHash: "b".repeat(64) };
  mkdirSync(join(root, "packages/machines/src"), { recursive: true }); mkdirSync(join(root, "script"));
  writeFileSync(join(root, target), "export const loaded = 1;\nexport const missing = () => 2;\n// artifact\n");
  writeFileSync(join(root, anchor), "export const anchor = 1;\n");
  const make = (lane: string, lcov: string) => ({ version: 1, complete: true, lane, run, runtime: Bun.version, inventoryHash: identity.inventoryHash, lcovHash: digest(lcov), lcov, files: parseNativeLcov(lcov, lane) });
  const records = [
    make("packages/machines", `SF:src/a.ts\nDA:1,${hits}\nDA:2,0\nLF:2\nLH:${hits > 0 ? 1 : 0}\nend_of_record\n`),
    make("script", "SF:anchor.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\nSF:../packages/machines/src/a.ts\nDA:1,0\nDA:3,0\nLF:2\nLH:0\nend_of_record\n"),
  ];
  for (const row of records) writeFileSync(join(root, `${row.lane.replaceAll("/", "-")}.json`), JSON.stringify(row));
  return { target, run, identity, records };
}
