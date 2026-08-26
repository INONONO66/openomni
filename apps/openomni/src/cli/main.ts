import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";
import { installShutdownHandlers, startOpenOmni } from "../index";
import { runCli } from "./commands";
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

const home = homedir();
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
    const result = spawnSync(command, rest, { encoding: "utf-8" });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
  writeFile: (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  removeFile: (path: string): void => rmSync(path, { force: true }),
  fileExists: existsSync,
};

async function startApp(): Promise<void> {
  applyEnvFile(envPath, process.env);
  mkdirSync(join(home, ".openomni"), { recursive: true });
  const config = loadConfig();
  const app = await startOpenOmni({ config });
  installShutdownHandlers({
    stop: app.stop,
    exit: (code) => process.exit(code),
    on: (signal, handler) => process.once(signal, handler),
  });
  console.log(`OpenOmni Resident listening at ws://${config.host}:${app.port}/ws`);
}

async function ask(question: string, options?: AskOptions): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("onboarding requires an interactive terminal");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = options?.fallback === undefined ? "" : ` [${options.fallback}]`;
    return await rl.question(`${question}${suffix}: `);
  } finally {
    rl.close();
  }
}

async function doctorPorts(): Promise<DoctorPorts> {
  const fileEnv = existsSync(envPath)
    ? parseEnvFile(await Bun.file(envPath).text())
    : undefined;
  const effective =
    fileEnv === undefined
      ? undefined
      : new Map(
          [...fileEnv].map(([key, value]) => [key, process.env[key] ?? value] as const),
        );
  return {
    bunVersion: Bun.version,
    envFile: effective,
    unitInstalled: existsSync(unitPath(target)),
    daemonActive: daemonActive(target, io),
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
    const child = spawn(command, rest, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const code = await runCli(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  target,
  io,
  envPath,
  startApp,
  ask,
  writeEnv: (entries) => writeEnvFile(envPath, entries),
  doctorPorts,
  follow,
});
if (code !== 0) {
  process.exit(code);
}
