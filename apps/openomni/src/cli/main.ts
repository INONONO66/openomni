import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";
import { installShutdownHandlers, startOpenOmni } from "../index";
import { runProvisioningInit } from "../provisioning/init";
import { type CliDeps, runCli } from "./commands";
import type { DaemonIo, DaemonTarget, ExecResult } from "./daemon";
import { daemonActive, unitPath } from "./daemon";
import { applyEnvFile, parseEnvFile, writeEnvFile } from "./env-file";
import type { DoctorPorts } from "./doctor";
import type { AskOptions } from "./onboard";

/**
 * Real-IO entry point. All behavior lives in `commands.ts` and friends;
 * this file only binds the process environment and executes.
 */
function resolvePlatform(): "darwin" | "linux" {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  throw new Error(`unsupported platform: ${process.platform} (darwin and linux only)`);
}

async function ask(question: string, options?: AskOptions): Promise<string> {
  // Check if stdin is available for interactive input. Paused stdin means it's not
  // available (e.g., in tests within a PTY from script -q).
  if (!process.stdin.isTTY || process.stdin.isPaused?.()) {
    throw new Error("onboarding requires an interactive terminal");
  }
  if (options?.secret) {
    // Secrets must not echo: readline writes to a sink while the prompt
    // itself goes straight to the real terminal.
    const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    try {
      process.stdout.write(`${question}: `);
      const answer = await rl.question("");
      process.stdout.write("\n");
      return answer;
    } finally {
      rl.close();
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = options?.fallback === undefined ? "" : ` [${options.fallback}]`;
    return await rl.question(`${question}${suffix}: `);
  } finally {
    rl.close();
  }
}

export interface CliRuntimeOptions {
  /** Cancels a long-running follow child, with hard-kill escalation. */
  readonly followSignal?: AbortSignal;
}

export function createCliDeps(home: string = homedir(), options: CliRuntimeOptions = {}): CliDeps {
  const envPath = join(home, ".openomni", "env");
  const target: DaemonTarget = {
    platform: resolvePlatform(),
    home,
    uid: process.getuid?.() ?? 0,
    bunPath: process.execPath,
    entryPath: fileURLToPath(import.meta.url),
  };
  const io: DaemonIo = {
    exec: (argv: readonly string[]): ExecResult => {
      const [command, ...rest] = argv;
      if (command === undefined) throw new Error("exec requires a command");
      const result = spawnSync(command, rest, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    writeFile: (path: string, content: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    removeFile: (path: string): void => rmSync(path, { force: true }),
    makeDir: (path: string): void => {
      mkdirSync(path, { recursive: true });
    },
    fileExists: existsSync,
  };

  async function startApp(): Promise<void> {
    applyEnvFile(envPath, process.env);
    mkdirSync(join(home, ".openomni"), { recursive: true });
    const config = loadConfig(home);
    const app = await startOpenOmni({ config });
    installShutdownHandlers({
      stop: app.stop,
      exit: (code) => process.exit(code),
      on: (signal, handler) => process.once(signal, handler),
    });
    console.log(`OpenOmni Resident listening at ws://${config.host}:${app.port}/ws`);
  }

  async function doctorPorts(): Promise<DoctorPorts> {
    const envFilePresent = existsSync(envPath);
    const effectiveEnv = new Map<string, string>(
      envFilePresent ? parseEnvFile(await Bun.file(envPath).text()) : [],
    );
    // A fully exported environment with no file is a supported shape.
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("OPENOMNI_") && value !== undefined) effectiveEnv.set(key, value);
    }
    const lingerEnabled = ((): boolean | undefined => {
      if (target.platform !== "linux") return undefined;
      const result = io.exec(["loginctl", "show-user", String(target.uid), "--property=Linger"]);
      // An unverifiable linger state gets the warning, not the benefit of the doubt.
      return result.code === 0 && result.stdout.includes("Linger=yes");
    })();
    return {
      bunVersion: Bun.version,
      envFilePresent,
      effectiveEnv,
      unitInstalled: existsSync(unitPath(target)),
      daemonActive: daemonActive(target, io),
      lingerEnabled,
      probeHealth: async (port: number): Promise<boolean> => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(3_000),
          });
          return response.ok;
        } catch {
          return false;
        }
      },
    };
  }

  function follow(argv: readonly string[]): Promise<number> {
    return new Promise((resolve) => {
      const [command, ...rest] = argv;
      if (command === undefined) {
        resolve(1);
        return;
      }
      const child = spawn(command, rest, { stdio: ["ignore", "inherit", "inherit"] });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = (): void => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      };
      const settle = (code: number): void => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        options.followSignal?.removeEventListener("abort", abort);
        resolve(code);
      };
      child.once("exit", (code) => settle(code ?? 1));
      child.once("error", () => settle(1));
      options.followSignal?.addEventListener("abort", abort, { once: true });
      if (options.followSignal?.aborted) abort();
    });
  }

  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    target,
    io,
    envPath,
    startApp,
    runInit: () => {
      applyEnvFile(envPath, process.env);
      return Promise.resolve(
        runProvisioningInit({ config: loadConfig(home), env: process.env, home, now: Date.now }),
      );
    },
    ask,
    writeEnv: (entries) => writeEnvFile(envPath, entries),
    doctorPorts,
    follow,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, createCliDeps());
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
