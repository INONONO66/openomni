import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import { Bus } from "@openomni/agent";
import { PROCESS_WORKER_NO_REQUEST_EXIT } from "../src/delegation/process-entry";
import { startOpenOmni } from "../src/index";

const appDir = join(import.meta.dir, "..");
const staging = join(appDir, "dist-npm");

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
  afterAll(() => {
    rmSync(staging, { recursive: true, force: true });
  });

  test("build stages a dependency-free package whose bundle boots with real migrations", async () => {
    const build = Bun.spawnSync([process.execPath, "run", "script/build-npm-package.ts"], {
      cwd: appDir,
    });
    expect(build.exitCode).toBe(0);

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
    const home = tempDir("openomni-pack-home-");
    const proc = Bun.spawn([process.execPath, join(staging, "dist", "app", "main.js"), "start"], {
      cwd: staging,
      env: {
        ...process.env,
        HOME: home,
        OPENOMNI_DB_PATH: join(home, "storage.db"),
        OPENOMNI_MEMORY_PATH: join(home, "memory.json"),
        OPENOMNI_WS_PORT: "0",
        OPENOMNI_MODEL_PROVIDER: "fake",
        OPENOMNI_MODEL_ID: "pack-smoke",
        OPENOMNI_MODEL_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await Promise.race([
        readListeningPort(proc.stdout),
        proc.exited.then(async (code) => {
          throw new Error(
            `bundle exited early (${code}): ${await new Response(proc.stderr).text()}`,
          );
        }),
      ]);
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
    } finally {
      proc.kill();
      await proc.exited;
    }

    // The bundled worker must be executable, not merely present: with stdin
    // closed it must reach its own request-line guard and exit with the
    // dedicated sentinel code — load errors and top-level exceptions exit 1
    // and cannot fake this.
    const worker = Bun.spawnSync(
      [process.execPath, join(staging, "dist", "app", "process-entry.js")],
      {
        cwd: staging,
        stdin: new Uint8Array(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(worker.exitCode).toBe(PROCESS_WORKER_NO_REQUEST_EXIT);
    expect(worker.stdout.toString()).toBe("");
  }, 30_000);
});

async function readListeningPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const match = buffer.match(/listening at ws:\/\/127\.0\.0\.1:(\d+)\/ws/);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  throw new Error(`bundle never reported a listening port; stdout was: ${buffer}`);
}
