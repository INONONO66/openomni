import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSupervisor } from "../../src/worker-supervision/supervisor.js";

const FIXTURE = new URL("../harness/rejecting-worker-fixture.ts", import.meta.url).pathname;

let tempDir: string;
let supervisor: WorkerSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

test("a rejected bootstrap attempt closes its IPC client instead of leaking it", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "bootstrap-leak-"));
  const logPath = join(tempDir, "openomni-worker-991.sock.log");

  // Construction spawns the worker and begins the connect loop.
  supervisor = new WorkerSupervisor({
    id: 991,
    script: FIXTURE,
    socketDir: tempDir,
    events: { publish: () => undefined },
  });
  // Long enough for several ~100ms retry rounds against the rejecting
  // bootstrap; a leak accumulates one live client per round.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await supervisor.stop();

  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line === "open" || line === "close");
  let live = 0;
  let peak = 0;
  for (const line of lines) {
    live += line === "open" ? 1 : -1;
    peak = Math.max(peak, live);
  }
  const attempts = lines.filter((line) => line === "open").length;
  // Sanity: the loop really retried more than once (else the pin is vacuous).
  expect(attempts).toBeGreaterThan(2);
  // Pin: failed attempts release their clients — at most the current attempt
  // (plus one mid-handoff straggler) is ever alive at once.
  expect(peak).toBeLessThanOrEqual(2);
});
