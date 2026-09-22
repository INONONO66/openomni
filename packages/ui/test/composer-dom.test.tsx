import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Like tabs.fixture.tsx, use a fresh module registry: another test may have
// imported React DOM before a DOM existed, permanently disabling input events.
test("mounted composer dispatches input, send, stop and approval actions", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", fileURLToPath(import.meta.resolve("./composer-dom.fixture.tsx"))],
    { cwd: import.meta.dir, stdout: "inherit", stderr: "inherit", timeout: 10_000 },
  );
  expect(await child.exited).toBe(0);
}, 15_000);
