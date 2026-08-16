/**
 * Boots the built artifact end-to-end in a throwaway HOME: non-interactive
 * onboard, then serve until /health answers. This is the fail-closed publish
 * gate — it proves the bundle layout (worker entry + migration resolution)
 * actually starts, not just that the build emitted files.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const root = join(import.meta.dir, "..");

// #552: the published surface stays bin-only until a library surface is
// deliberately frozen. A root `exports`/`main`/`types`/`module` field would
// silently publish importable internals, so it fails the gate here.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as Record<
  string,
  unknown
>;
if (!pkg.bin || typeof pkg.bin !== "object") {
  console.error("package.json must declare a bin entry — the published surface is the CLI");
  process.exit(1);
}
const libraryFields = ["exports", "main", "types", "module"].filter((field) => field in pkg);
if (libraryFields.length > 0) {
  console.error(
    `package.json declares ${libraryFields.join(", ")} — the published surface is bin-only (#552); remove the field(s) or deliberately freeze a library surface first`,
  );
  process.exit(1);
}

const cli = join(root, "dist", "bin", "cli.js");
if (!existsSync(cli)) {
  console.error("dist/bin/cli.js missing — run script/build-dist.ts first");
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "openomni-smoke-"));
// probe a free port instead of guessing — a collision would fail the release gate spuriously
const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port;
probe.stop(true);
const env = {
  ...process.env,
  HOME: home,
  OPENOMNI_AUTH_FILE: join(home, ".openomni", "auth.json"),
  OPENOMNI_DISABLE_MODELS_FETCH: "1",
};

// Pinned to the piped shape the spawn below configures: `ReturnType<typeof
// Bun.spawn>` would erase the stdout/stderr inference back to the full union.
let serve: Subprocess<"ignore", "pipe", "pipe"> | undefined;
try {
  const onboard = Bun.spawnSync(
    [process.execPath, cli, "onboard", "--port", String(port), "--host", "127.0.0.1"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if (onboard.exitCode !== 0) {
    console.error(onboard.stdout.toString(), onboard.stderr.toString());
    throw new Error(`onboard exited with ${onboard.exitCode}`);
  }
  if (!existsSync(join(home, ".openomni", "config.json"))) {
    throw new Error("onboard did not write config.json");
  }

  serve = Bun.spawn([process.execPath, cli, "serve"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Start draining immediately — an undrained pipe backpressures the child
  // once the buffer fills, which can stall the server mid-boot.
  const serveStdout = new Response(serve.stdout).text();
  const serveStderr = new Response(serve.stderr).text();

  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (serve.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      await Bun.sleep(250);
    }
  }
  if (!healthy) {
    serve.kill("SIGTERM");
    const [stdout, stderr] = await Promise.all([serveStdout, serveStderr]);
    console.error(stdout, stderr);
    throw new Error("bundled server never answered /health");
  }
  console.log(`smoke ok: onboard + serve answered /health on :${port}`);
} finally {
  if (serve && serve.exitCode === null) {
    serve.kill("SIGTERM");
    const exited = await Promise.race([serve.exited, Bun.sleep(5000).then(() => "timeout")]);
    if (exited === "timeout") serve.kill("SIGKILL");
  }
  rmSync(home, { recursive: true, force: true });
}
