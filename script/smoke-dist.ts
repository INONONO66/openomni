/**
 * Boots the built artifact end-to-end in a throwaway HOME: non-interactive
 * onboard, then serve until /health answers. This is the fail-closed publish
 * gate — it proves the bundle layout (worker entry + migration resolution)
 * actually starts, not just that the build emitted files.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
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

let serve: ReturnType<typeof Bun.spawn> | undefined;
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
    const [stdout, stderr] = await Promise.all([
      new Response(serve.stdout).text(),
      new Response(serve.stderr).text(),
    ]);
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
