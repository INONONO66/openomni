import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { createDispositionFixture, seedRetiredWait, snapshotDatabase } from "../packages/ledger/test/helpers/disposition-967";

const boundaries = ["snapshot", "archive_write", "archive_file_fsync", "archive_publish", "archive_directory_fsync",
  "restore_copy", "restore_open", "manifest_file_fsync", "manifest_publish", "manifest_directory_fsync"] as const;

for (const mode of ["throw", "crash"] as const) {
  describe(`967 real CLI disposal matrix durable archive ${mode}`, () => {
    test.each([...boundaries])("preserves source and cleans owned resources at %s", (boundary) => {
      using fixture = createDispositionFixture();
      seedRetiredWait(fixture.db);
      const before = snapshotDatabase(fixture.db);
      const args = [process.execPath, "--preload", resolve(import.meta.dir, "../packages/ledger/test/helpers/disposition-967-archive-fault.ts"),
        resolve(import.meta.dir, "generate-ledger-archive-manifest.ts"), "--db", fixture.path, "--out", fixture.manifest, "--backup", fixture.archive, "--json"];
      const result = Bun.spawnSync(args, { env: { ...process.env, U967_ARCHIVE_BOUNDARY: boundary, U967_FAULT_MODE: mode },
        stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      const stdout = result.stdout.toString();
      console.log(JSON.stringify({ args, mode, boundary, exit: result.exitCode, signal: result.signalCode, stdout, stderr: result.stderr.toString() }));
      // Attempt every cleanup; native disposal preserves assertion and cleanup failures.
      using cleanup = new DisposableStack();
      for (const line of stdout.split("\n").filter(Boolean)) {
        cleanup.defer(() => {
          const resource = z.object({ ownedRestore: z.string().optional() }).parse(JSON.parse(line));
          if (resource.ownedRestore === undefined) return;
          rmSync(resource.ownedRestore, { recursive: true, force: true });
          expect(existsSync(resource.ownedRestore)).toBe(false);
          console.log(JSON.stringify({ cleanup: resource.ownedRestore, removed: true, owner: "archive-child" }));
        });
      }
      expect(result.exitCode).not.toBe(0);
      expect(stdout).toContain(`"archiveBoundary":"${boundary}"`);
      expect(snapshotDatabase(fixture.db)).toEqual(before);
      if (existsSync(fixture.archive)) expect(statSync(fixture.archive).mode & 0o777).toBe(0o600);
      if (mode === "throw") expect(stdout).toContain('"openDescriptors":0,"ownedRestores":0');
    });
  });
}
