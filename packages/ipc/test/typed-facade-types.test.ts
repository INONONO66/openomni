import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixtureConfig = fileURLToPath(
  new URL("./typed-facade-fixtures/tsconfig.json", import.meta.url),
);

test("typed facade rejects schema-invalid calls while generic calls remain valid", () => {
  const result = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", fixtureConfig], {
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    throw new Error(`typed facade compile fixture failed:\n${output}`);
  }

  expect(result.exitCode).toBe(0);
});
