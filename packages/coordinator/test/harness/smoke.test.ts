import { describe, test } from "bun:test";
import { assertCleanExit, assertNoOrphanProcesses } from "./assertions";

describe("harness", () => {
  test("spawn and exit cleanly", async () => {
    const beforePids = [process.pid];

    const proc = Bun.spawn(["bun", "-e", "process.exit(0)"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await assertCleanExit(proc);

    const afterPids = [process.pid];
    assertNoOrphanProcesses(beforePids, afterPids);
  });
});
