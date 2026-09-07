import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { createDispositionFixture } from "./disposition-967";

type Fixture = ReturnType<typeof createDispositionFixture>;

export function manifestHash(fixture: Fixture): string {
  return createHash("sha256").update(readFileSync(fixture.manifest)).digest("hex");
}

export function archiveCli(fixture: Fixture, flags: readonly string[] = [], report = true) {
  const args = [
    process.execPath,
    "run",
    resolve(import.meta.dir, "../../../../script/generate-ledger-archive-manifest.ts"),
    "--db",
    fixture.path,
    "--out",
    fixture.manifest,
    "--backup",
    fixture.archive,
    "--json",
    ...flags,
  ];
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const receipt = {
    args,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
  if (report) console.log(JSON.stringify(receipt));
  return receipt;
}

export function archiveAndVerify(fixture: Fixture) {
  for (const flags of [[], ["--verify"]]) {
    const result = archiveCli(fixture, flags);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
}

export function disposeCli(fixture: Fixture, report = true) {
  return archiveCli(
    fixture,
    ["--dispose-967", "--approve-manifest-sha256", manifestHash(fixture)],
    report,
  );
}
