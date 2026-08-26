import { join } from "node:path";
import {
  type DaemonIo,
  type DaemonTarget,
  daemonInstall,
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall,
} from "./daemon";
import type { EnvEntry } from "./env-file";
import type { DoctorCheck, DoctorPorts } from "./doctor";
import { runDoctor } from "./doctor";
import type { Ask } from "./onboard";
import { gatherOnboarding } from "./onboard";

/**
 * Command dispatch with every side effect injected. `main.ts` is the only
 * place real IO gets bound, so the whole CLI surface is testable.
 */
export interface CliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly target: DaemonTarget;
  readonly io: DaemonIo;
  readonly envPath: string;
  readonly startApp: () => Promise<void>;
  readonly ask: Ask;
  readonly writeEnv: (entries: readonly EnvEntry[]) => void;
  readonly doctorPorts: () => Promise<DoctorPorts>;
  /** Runs a follow-style child (tail/journalctl) to completion; returns its exit code. */
  readonly follow: (argv: readonly string[]) => Promise<number>;
}

const USAGE = `openomni — Single-Owner Agent OS

Usage:
  openomni start                 run the Resident in the foreground
  openomni onboard               interactive setup → ~/.openomni/env
  openomni daemon <verb>         install | uninstall | status | start | stop | restart
  openomni doctor                read-only diagnostics
  openomni logs                  follow the daemon logs
  openomni help                  show this message`;

const DAEMON_VERBS: Record<
  string,
  (target: DaemonTarget, io: DaemonIo) => string
> = {
  install: daemonInstall,
  uninstall: daemonUninstall,
  status: daemonStatus,
  start: daemonStart,
  stop: daemonStop,
  restart: daemonRestart,
};

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const command = args[0] ?? "help";
  switch (command) {
    case "start":
      await deps.startApp();
      return 0;
    case "onboard":
      return await onboard(deps);
    case "daemon":
      return daemon(args[1], deps);
    case "doctor":
      return await doctor(deps);
    case "logs":
      return await deps.follow(logsArgv(deps.target));
    case "help":
    case "--help":
    case "-h":
      deps.stdout(USAGE);
      return 0;
    default:
      deps.stderr(`unknown command: ${command}`);
      deps.stderr(USAGE);
      return 1;
  }
}

async function onboard(deps: CliDeps): Promise<number> {
  if (deps.io.fileExists(deps.envPath)) {
    const answer = await deps.ask(`${deps.envPath} exists — overwrite? (y/N)`);
    if (answer.trim().toLowerCase() !== "y") {
      deps.stdout("keeping the existing env file");
      return 0;
    }
  }
  deps.writeEnv(await gatherOnboarding(deps.ask));
  deps.stdout(`wrote ${deps.envPath}`);
  deps.stdout("next: `openomni daemon install` to run 24/7, or `openomni start` to try it now");
  return 0;
}

function daemon(verb: string | undefined, deps: CliDeps): number {
  const handler = verb === undefined ? undefined : DAEMON_VERBS[verb];
  if (handler === undefined) {
    deps.stderr("usage: openomni daemon install | uninstall | status | start | stop | restart");
    return 1;
  }
  try {
    deps.stdout(handler(deps.target, deps.io));
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function doctor(deps: CliDeps): Promise<number> {
  const report = await runDoctor(await deps.doctorPorts());
  const format = (check: DoctorCheck): string =>
    `${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}`;
  for (const check of report.checks) {
    deps.stdout(format(check));
  }
  return report.ok ? 0 : 1;
}

function logsArgv(target: DaemonTarget): readonly string[] {
  return target.platform === "darwin"
    ? ["tail", "-n", "50", "-F", join(target.home, ".openomni", "logs", "openomni.log")]
    : ["journalctl", "--user", "-u", "openomni", "-f"];
}
