import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createPrivateSocketDir } from "../../src/worker-manager/worker-socket-dir";
import { collectorPorts } from "../harness/ports";

const baseDir = `/tmp/omo-sd-${process.pid}-${Date.now()}`;

function makeWorkersDir(name: string): string {
  const dir = path.join(baseDir, `openomni-workers-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function spawnDeadPid(): Promise<number> {
  const proc = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.pid;
}

beforeEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });
});

describe("stale socket-dir cleanup (#audit M1)", () => {
  test("a live owner's dir survives even with zero listening sockets", () => {
    // The exact scenario the old connect-probe sweep destroyed: a live
    // manager whose only worker sits in restart backoff (no .sock answers).
    const liveDir = makeWorkersDir("live");
    fs.writeFileSync(path.join(liveDir, "owner.pid"), String(process.pid));
    fs.writeFileSync(path.join(liveDir, "openomni-worker-0.sock"), "");

    createPrivateSocketDir(baseDir, collectorPorts().events);

    expect(fs.existsSync(liveDir)).toBe(true);
  });

  test("a dead owner's dir is removed", async () => {
    const deadDir = makeWorkersDir("dead");
    fs.writeFileSync(path.join(deadDir, "owner.pid"), String(await spawnDeadPid()));
    fs.writeFileSync(path.join(deadDir, "openomni-worker-0.sock"), "");

    createPrivateSocketDir(baseDir, collectorPorts().events);

    expect(fs.existsSync(deadDir)).toBe(false);
  });

  test("an unmarked dir is cleaned by age, including empty ones", () => {
    const oldEmptyDir = makeWorkersDir("old-empty");
    const oldTime = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(oldEmptyDir, oldTime, oldTime);
    const freshDir = makeWorkersDir("fresh");

    createPrivateSocketDir(baseDir, collectorPorts().events);

    expect(fs.existsSync(oldEmptyDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  test("the created dir carries its owner's pid marker", () => {
    const dir = createPrivateSocketDir(baseDir, collectorPorts().events);

    expect(fs.readFileSync(path.join(dir, "owner.pid"), "utf8")).toBe(String(process.pid));
  });
});
