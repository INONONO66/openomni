import fs from "node:fs";
import path from "node:path";
import type { BusEvent } from "@openomni/protocol";

export function createPrivateSocketDir(baseDir: string, _events: BusEvent.Sink): string {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(baseDir, "openomni-workers-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function createSupervisorSocketDir(baseDir: string, workerId: number): string {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(baseDir, `worker-${workerId}-`));
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function createGenerationSocketPath(supervisorDir: string): string {
  return path.join(supervisorDir, `${crypto.randomUUID()}.sock`);
}
