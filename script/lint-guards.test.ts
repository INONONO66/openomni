import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { main } from "./lint-guards";

test("the shipped tree passes every guard rule in-process", async () => {
  const cwd = process.cwd();
  process.chdir(join(import.meta.dir, ".."));
  const lines: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    // main exits the process on any guard violation, so returning is the verdict.
    await expect(main()).resolves.toBeUndefined();
  } finally {
    write.mockRestore();
    process.chdir(cwd);
  }
  expect(lines.join("")).toMatch(/^OK: guard lint scanned \d+ TypeScript files\n$/);
});
