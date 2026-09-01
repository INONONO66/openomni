/**
 * #502 rename verifier: proves zero old package identity remains.
 *
 * Rejects, across every tracked file (including bun.lock and this script):
 * - the old package name (the pre-#502 "session" name under the @openomni
 *   scope)
 * - the old directory path (the pre-#502 "session" directory under packages/)
 * - any old lock entry / workspace resolution / tsconfig path mapping using
 *   either identity
 * and requires the renamed identity to actually exist: `packages/ledger/`
 * with `"name": "@openomni/ledger"`, a `@openomni/ledger` workspace entry in
 * `bun.lock`, and the moved migration tree.
 *
 * The banned literals are assembled from fragments so this file passes its
 * own scan honestly rather than being exempted.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OLD_PACKAGE_NAME = ["@openomni", "session"].join("/");
const OLD_PACKAGE_PATH = ["packages", "session"].join("/");
const BANNED = [OLD_PACKAGE_NAME, OLD_PACKAGE_PATH];

const root = new URL("..", import.meta.url).pathname;

async function main(): Promise<void> {
  const failures: string[] = [];

  // 1. Old directory must be gone; new directory and migrations must exist.
  if (existsSync(join(root, OLD_PACKAGE_PATH))) {
    failures.push(`old directory still exists: ${OLD_PACKAGE_PATH}`);
  }
  if (!existsSync(join(root, "packages/ledger/package.json"))) {
    failures.push("missing packages/ledger/package.json");
  }
  const migrationDir = join(root, "packages/ledger/migration");
  if (!existsSync(migrationDir)) {
    failures.push("missing packages/ledger/migration");
  } else {
    const migrations = readdirSync(migrationDir).filter((name) => /^\d{4}_/.test(name));
    if (migrations.length < 18) {
      failures.push(`expected >= 18 migration directories, found ${migrations.length}`);
    }
  }

  // 2. New identity is the manifest name.
  const manifest = (await Bun.file(join(root, "packages/ledger/package.json")).json()) as {
    name?: string;
  };
  if (manifest.name !== "@openomni/ledger") {
    failures.push(`packages/ledger/package.json name is ${JSON.stringify(manifest.name)}`);
  }

  // 3. Lockfile carries the new workspace mapping and none of the old one.
  const lock = await Bun.file(join(root, "bun.lock")).text();
  if (!lock.includes('"packages/ledger"')) {
    failures.push("bun.lock has no packages/ledger workspace entry");
  }
  if (!lock.includes("@openomni/ledger")) {
    failures.push("bun.lock has no @openomni/ledger resolution");
  }

  // 4. Zero old identity across every tracked file (lock, tsconfigs, CI,
  //    scripts, docs, fixtures — everything git tracks), this script included.
  const proc = Bun.spawnSync(["git", "ls-files"], { cwd: root });
  if (proc.exitCode !== 0) {
    failures.push(`git ls-files failed: ${proc.stderr.toString()}`);
  }
  const trackedFiles = proc.stdout
    .toString()
    .split("\n")
    .filter((line) => line.length > 0);

  for (const file of trackedFiles) {
    const absolute = join(root, file);
    if (!existsSync(absolute)) continue; // tracked but deleted in worktree
    const content = await Bun.file(absolute)
      .text()
      .catch(() => null);
    if (content === null) continue; // binary or unreadable
    for (const banned of BANNED) {
      if (content.includes(banned)) {
        const line = content.split("\n").findIndex((l) => l.includes(banned)) + 1;
        failures.push(`${file}:${line} contains banned identity "${banned}"`);
      }
    }
  }

  // 5. From a real consumer package the old specifier must not resolve and the
  //    new one must import cleanly. (The workspace root declares no dependency
  //    on either name, so resolution is checked where consumers live.)
  const consumerDir = join(root, "apps/openomni");
  try {
    const resolved = Bun.resolveSync(OLD_PACKAGE_NAME, consumerDir);
    failures.push(`"${OLD_PACKAGE_NAME}" unexpectedly resolves to ${resolved}`);
  } catch {
    // expected: resolution failure
  }
  try {
    const resolved = Bun.resolveSync("@openomni/ledger", consumerDir);
    await import(resolved);
  } catch (err) {
    failures.push(`import("@openomni/ledger") failed from apps/openomni: ${String(err)}`);
  }

  if (failures.length > 0) {
    console.error(`verify-ledger-rename: FAIL (${failures.length})`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `verify-ledger-rename: OK — ${trackedFiles.length} tracked files scanned, ` +
      "zero old identity; @openomni/ledger resolves, old name does not",
  );
}

if (import.meta.main) {
  await main();
}
