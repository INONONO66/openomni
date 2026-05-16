import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./bash";

describe("bashTool", () => {
  const originalAuthFile = process.env.OPENOMNI_AUTH_FILE;
  const originalDbPath = process.env.OPENOMNI_DB_PATH;
  const originalHome = process.env.HOME;

  afterEach(() => {
    restoreEnv("OPENOMNI_AUTH_FILE", originalAuthFile);
    restoreEnv("OPENOMNI_DB_PATH", originalDbPath);
    restoreEnv("HOME", originalHome);
  });

  test("scrubs auth paths from subprocess environment", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-bash-env-"));
    process.env.OPENOMNI_AUTH_FILE = "/tmp/openomni-secret-auth.json";
    process.env.OPENOMNI_DB_PATH = "/tmp/openomni-secret.db";
    process.env.HOME = "/tmp/openomni-secret-home";

    try {
      const tool = bashTool(workspace);
      const result = await tool.execute({
        id: "call-1",
        tool: "bash",
        input: {
          command:
            'printf \'auth=%s db=%s home=%s\' "$OPENOMNI_AUTH_FILE" "$OPENOMNI_DB_PATH" "$HOME"',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.output).toBe(`auth= db= home=${workspace}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
