import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const DEFAULT_PID_PATH = path.join(homedir(), ".openomni", "daemon.pid");

export function writePid(pidPath = DEFAULT_PID_PATH): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid));
}

export function removePid(pidPath = DEFAULT_PID_PATH): void {
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // already gone
  }
}

export function readPid(pidPath = DEFAULT_PID_PATH): number | undefined {
  try {
    const content = fs.readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}
