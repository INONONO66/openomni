import { describe, test } from "bun:test";
import { assertCleanExit, assertNoOrphanProcesses, listChildPids } from "./assertions";

describe("harness", () => {
  test("spawn and exit cleanly without orphaning children", async () => {
    // A real pre/post comparison of this process's child tree — the old
    // version compared [process.pid] to [process.pid], which could never fail.
    const beforePids = listChildPids();

    const proc = Bun.spawn(["bun", "-e", "process.exit(0)"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await assertCleanExit(proc);

    const afterPids = listChildPids();
    assertNoOrphanProcesses(beforePids, afterPids);
  });
});
