import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Storage } from "@openomni/ledger";
import { Bus } from "@openomni/agent";
import { PROCESS_WORKER_NO_REQUEST_EXIT } from "../src/delegation/process-entry";
import { startOpenOmni } from "../src/index";

const appDir = join(import.meta.dir, "..");

const directories: string[] = [];
let stopApp: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopApp?.();
  stopApp = undefined;
  Bus.reset();
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("health endpoint", () => {
  test("GET /health answers ok on the ws port", async () => {
    const directory = tempDir("openomni-health-");
    const app = await startOpenOmni({
      config: {
        dbPath: join(directory, "openomni.db"),
        host: "127.0.0.1",
        wsPort: 0,
        model: { provider: "fake", id: "health-test", apiKey: "test-key" },
      },
    });
    stopApp = () => app.stop();
    const response = await fetch(`http://127.0.0.1:${app.port}/health`);
    expect(response.status).toBe(200);
    // Liveness only: any extra field on this unauthenticated surface is disclosure.
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("npm package staging", () => {
  test("build stages a dependency-free package whose bundle boots with real migrations", async () => {
    const staging = tempDir("openomni-pack-staging-");
    const home = tempDir("openomni-pack-home-");
    const env = {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      OPENOMNI_DB_PATH: join(home, "storage.db"),
      OPENOMNI_MEMORY_PATH: join(home, "memory.json"),
      OPENOMNI_AUTH_FILE: join(home, "auth.json"),
      OPENOMNI_MODELS_PATH: join(home, "models.json"),
      OPENOMNI_DISABLE_MODELS_FETCH: "1",
      OPENOMNI_MACHINES_SOCKET: join(home, "machines.sock"),
      OPENOMNI_WS_HOST: "127.0.0.1",
      OPENOMNI_WS_PORT: "0",
      OPENOMNI_MODEL_PROVIDER: "fake",
      OPENOMNI_MODEL_ID: "pack-smoke",
      OPENOMNI_MODEL_API_KEY: "test-key",
    };
    const build = Bun.spawnSync([process.execPath, "run", "script/build-npm-package.ts", staging], {
      cwd: appDir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    // Manifest contract: no workspace deps may leak into the registry artifact.
    const manifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf-8")) as {
      name: string;
      bin: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("openomni");
    expect(manifest.dependencies).toBeUndefined();
    expect(existsSync(join(staging, manifest.bin.openomni ?? ""))).toBe(true);
    // Layout contract pinned by ledger's `import.meta.dir + ../../migration`.
    expect(existsSync(join(staging, "migration", "0001_initial", "migration.sql"))).toBe(true);
    expect(existsSync(join(staging, "dist", "app", "process-entry.js"))).toBe(true);

    // Boot the bundle exactly as the daemon would: `bun dist/app/main.js start`.
    const proc = Bun.spawn([process.execPath, join(staging, "dist", "app", "main.js"), "start"], {
      cwd: staging,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const ready = Promise.withResolvers<number>();
    const stdout = drainListeningPort(proc.stdout, ready.resolve);
    const stderr = new Response(proc.stderr).text();
    const output = Promise.all([stdout, stderr]);
    try {
      const port = await bounded(
        Promise.race([
          ready.promise,
          proc.exited.then(async (code) => {
            const [out, err] = await output;
            throw new Error(`bundle exited early (${code}): ${out}\n${err}`);
          }),
          output.then(([out, err]) => {
            throw new Error(`bundle output closed before readiness: ${out}\n${err}`);
          }),
        ]),
        10_000,
      );
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(200);
    } finally {
      try {
        await terminate(proc);
      } finally {
        await bounded(output, 2_000);
      }
    }

    // The bundled worker must be executable, not merely present: with stdin
    // closed it must reach its own request-line guard and exit with the
    // dedicated sentinel code — load errors and top-level exceptions exit 1
    // and cannot fake this.
    const worker = Bun.spawnSync(
      [process.execPath, join(staging, "dist", "app", "process-entry.js")],
      {
        cwd: staging,
        env,
        timeout: 5_000,
        killSignal: "SIGKILL",
        stdin: new Uint8Array(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(worker.exitCode).toBe(PROCESS_WORKER_NO_REQUEST_EXIT);
    expect(worker.stdout.toString()).toBe("");
  }, 30_000);
});

async function drainListeningPort(
  stdout: ReadableStream<Uint8Array>,
  ready: (port: number) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const match = buffer.match(/listening at ws:\/\/127\.0\.0\.1:(\d+)\/ws/);
    if (match?.[1] !== undefined) ready(Number(match[1]));
  }
  return buffer;
}

class ChildTimeoutError extends Error {}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ChildTimeoutError(`child exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function terminate(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  // Signal termination leaves exitCode null: signalCode is also terminal evidence.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await bounded(child.exited, 1_000);
  } catch (error) {
    if (!(error instanceof ChildTimeoutError)) throw error;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(child.exited, 1_000);
  }
}
