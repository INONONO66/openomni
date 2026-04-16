import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandModule } from "yargs";

function readPidFile(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isNaN(pid) ? undefined : pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const DaemonCommand: CommandModule = {
  command: "daemon <action>",
  describe: "Manage the OpenOmni daemon",
  builder: (yargs) =>
    yargs.positional("action", {
      choices: ["start", "stop", "status"] as const,
      describe: "Lifecycle action",
    }),
  handler: async (argv) => {
    const action = argv["action"] as "start" | "stop" | "status";
    const pidFile = join(homedir(), ".openomni", "daemon.pid");

    if (action === "status") {
      const pid = readPidFile(pidFile);
      if (pid !== undefined && isProcessRunning(pid)) {
        console.log(`Daemon running (PID ${pid})`);
      } else {
        console.log("Daemon not running");
      }
      return;
    }

    if (action === "start") {
      const existing = readPidFile(pidFile);
      if (existing !== undefined && isProcessRunning(existing)) {
        console.log(`Daemon already running (PID ${existing})`);
        return;
      }
      console.log("Starting daemon...");
      const proc = Bun.spawn(["bun", "packages/coordinator/src/daemon/main.ts"], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.unref();
      console.log(`Daemon started (PID ${proc.pid})`);
      return;
    }

    if (action === "stop") {
      const pid = readPidFile(pidFile);
      if (pid === undefined || !isProcessRunning(pid)) {
        console.log("Daemon not running");
        return;
      }
      process.kill(pid, "SIGTERM");
      console.log(`Daemon stopped (PID ${pid})`);
    }
  },
};
