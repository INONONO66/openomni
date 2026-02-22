import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore } from "../../src/storage/gitignore";

describe("ensureGitignore", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates .gitignore when file doesn't exist", () => {
    tempDir = mkdtempSync(join(tmpdir(), "gitignore-test-"));
    const pattern = "node_modules/";

    ensureGitignore(tempDir, pattern);

    const gitignorePath = join(tempDir, ".gitignore");
    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toBe("node_modules/\n");
  });

  test("appends to existing .gitignore that lacks pattern", () => {
    tempDir = mkdtempSync(join(tmpdir(), "gitignore-test-"));
    const gitignorePath = join(tempDir, ".gitignore");
    writeFileSync(gitignorePath, "dist/\n", "utf-8");

    ensureGitignore(tempDir, "node_modules/");

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toBe("dist/\nnode_modules/\n");
  });

  test("is idempotent: calling twice doesn't duplicate pattern", () => {
    tempDir = mkdtempSync(join(tmpdir(), "gitignore-test-"));
    const pattern = "node_modules/";

    ensureGitignore(tempDir, pattern);
    ensureGitignore(tempDir, pattern);

    const gitignorePath = join(tempDir, ".gitignore");
    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toBe("node_modules/\n");
  });

  test("handles .gitignore with existing entries + no trailing newline", () => {
    tempDir = mkdtempSync(join(tmpdir(), "gitignore-test-"));
    const gitignorePath = join(tempDir, ".gitignore");
    writeFileSync(gitignorePath, "dist/", "utf-8"); // No trailing newline

    ensureGitignore(tempDir, "node_modules/");

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toBe("dist/\nnode_modules/\n");
  });

  test("preserves CRLF line endings: input with \\r\\n → output also uses \\r\\n", () => {
    tempDir = mkdtempSync(join(tmpdir(), "gitignore-test-"));
    const gitignorePath = join(tempDir, ".gitignore");
    writeFileSync(gitignorePath, "dist/\r\n", "utf-8");

    ensureGitignore(tempDir, "node_modules/");

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toBe("dist/\r\nnode_modules/\r\n");
  });

  test("pattern not added if already present (case-sensitive exact match after trim)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "gitignore-test-"));
    const gitignorePath = join(tempDir, ".gitignore");
    writeFileSync(gitignorePath, "  node_modules/  \n", "utf-8");

    ensureGitignore(tempDir, "node_modules/");

    const gitignorePath2 = join(tempDir, ".gitignore");
    const content = readFileSync(gitignorePath2, "utf-8");
    expect(content).toBe("  node_modules/  \n");
  });

  test("works with .gitignore that has comments and blank lines", () => {
    tempDir = mkdtempSync(join(tmpdir(), "gitignore-test-"));
    const gitignorePath = join(tempDir, ".gitignore");
    writeFileSync(gitignorePath, "# Comment\ndist/\n\n", "utf-8");

    ensureGitignore(tempDir, "node_modules/");

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toBe("# Comment\ndist/\n\nnode_modules/\n");
  });
});
