import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Client-only modules must observe a DOM before they load, independently of SSR test order.
test("mounted tabs and history in a client DOM", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", fileURLToPath(import.meta.resolve("./tabs.fixture.tsx"))],
    { cwd: join(import.meta.dir, "../../.."), stdout: "inherit", stderr: "inherit" },
  );
  expect(await child.exited).toBe(0);
}, 15_000);
