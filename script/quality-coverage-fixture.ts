import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./quality-inventory";
import { parseNativeLcov } from "./quality-native-lcov";

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
