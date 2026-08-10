/**
 * Builds the publishable `openomni` CLI artifact.
 *
 * Layout contract (pinned by script/smoke-dist.ts):
 * - dist/bin/cli.js          — bin entry (serve/onboard), self-contained bundle
 * - dist/bin/worker-entry.js — worker subprocess bundle, injected via
 *                              OPENOMNI_CLI_BUNDLE (see apps/server/src/cli.ts)
 * - migration/               — copy of packages/session/migration; the session
 *   package resolves `import.meta.dir/../../migration` at runtime, so the
 *   bundles MUST live exactly two directories below the package root.
 */
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "bin");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string };

rmSync(join(root, "dist"), { recursive: true, force: true });
rmSync(join(root, "migration"), { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [
    join(root, "apps/server/src/cli.ts"),
    join(root, "apps/server/src/execution/worker-entry.ts"),
  ],
  outdir: outDir,
  target: "bun",
  naming: "[name].[ext]",
  // jsdom (pulled in by the opensearch web-search tools) does dynamic
  // requires that cannot be bundled; it stays a real npm dependency of the
  // published package instead.
  external: ["opensearch-ai-sdk", "opensearch-ai-sdk/*"],
  define: {
    "process.env.OPENOMNI_CLI_BUNDLE": JSON.stringify("1"),
    "process.env.OPENOMNI_CLI_VERSION": JSON.stringify(pkg.version),
  },
  plugins: [
    {
      // @openomni/protocol is the one workspace package whose package.json
      // points at tsc output (./dist/index.js), which does not exist in a
      // pristine checkout (CI, fresh clone) — Bun.build then fails with
      // `Could not resolve: "@openomni/protocol"`. Bundle it from source,
      // exactly like every other workspace package already resolves.
      name: "workspace-protocol-from-src",
      setup(build) {
        build.onResolve({ filter: /^@openomni\/protocol$/ }, () => ({
          path: join(root, "packages/protocol/src/index.ts"),
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

cpSync(join(root, "packages/session/migration"), join(root, "migration"), { recursive: true });

const cliPath = join(outDir, "cli.js");
const workerPath = join(outDir, "worker-entry.js");
for (const path of [cliPath, workerPath]) {
  if (!existsSync(path)) {
    console.error(`build did not emit ${path}`);
    process.exit(1);
  }
}

const cli = readFileSync(cliPath, "utf-8");
if (!cli.startsWith("#!")) {
  writeFileSync(cliPath, `#!/usr/bin/env bun\n${cli}`);
}
chmodSync(cliPath, 0o755);

console.log(`built dist/bin (cli.js, worker-entry.js) for openomni@${pkg.version}`);
