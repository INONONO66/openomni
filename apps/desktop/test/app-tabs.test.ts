import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("mounted App tab, search, focus and chat contracts", async () => {
  const child = Bun.spawn(
    ["mise", "exec", "bun@1.4.1", "--", "bun", "test", fileURLToPath(import.meta.resolve("./app-tabs.fixture.tsx"))],
    { cwd: new URL("../../..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" },
  );
  expect(await child.exited).toBe(0);
}, 30_000);
