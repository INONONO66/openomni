import { expect, test } from "bun:test";
import { runTerminalC1 } from "./terminal-c1";

test("proves terminal C1 behavior across real spawned processes", async () => {
  const receipt = await runTerminalC1();
  expect(receipt).toMatchObject({
    proof: "terminal-separate-process-c1",
    noLiveReplayEffects: true,
    restart: { distinctPids: true },
  });
});
