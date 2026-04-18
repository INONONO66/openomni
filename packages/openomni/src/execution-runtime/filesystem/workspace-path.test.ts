import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContainedPath, resolveContainedPathForCreate } from "./workspace-path.js";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "workspace-path-test-"));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("resolveContainedPath", () => {
  it("resolves a non-existent file whose parent dir exists inside root", () => {
    const result = resolveContainedPath(workspaceRoot, "file.txt");
    expect(result).toBe(join(workspaceRoot, "file.txt"));
  });

  it("accepts the root path itself", () => {
    const result = resolveContainedPath(workspaceRoot, ".");
    expect(result).toBe(workspaceRoot);
  });

  it("rejects path traversal via ..", () => {
    expect(() => resolveContainedPath(workspaceRoot, "../../etc/passwd")).toThrow(
      "Path must stay within workspace root",
    );
  });

  it("rejects a single level traversal", () => {
    expect(() => resolveContainedPath(workspaceRoot, "../sibling")).toThrow(
      "Path must stay within workspace root",
    );
  });

  it("rejects an absolute path outside root", () => {
    expect(() => resolveContainedPath(workspaceRoot, "/etc/passwd")).toThrow(
      "Path must stay within workspace root",
    );
  });

  it("rejects an absolute path that is the root's sibling", () => {
    const sibling = join(workspaceRoot, "..", "other-dir");
    expect(() => resolveContainedPath(workspaceRoot, sibling)).toThrow(
      "Path must stay within workspace root",
    );
  });

  it("rejects a symlink that escapes the workspace root", () => {
    const escapeTarget = mkdtempSync(join(tmpdir(), "escape-target-"));
    const symlinkPath = join(workspaceRoot, "escape-link");
    symlinkSync(escapeTarget, symlinkPath);
    try {
      expect(() => resolveContainedPath(workspaceRoot, "escape-link/secret.txt")).toThrow(
        "Path escapes workspace root via symlink",
      );
    } finally {
      rmSync(symlinkPath);
      rmSync(escapeTarget, { recursive: true });
    }
  });

  it("allows a symlink that points to a path within the workspace root", () => {
    const symlinkPath = join(workspaceRoot, "internal-link");
    symlinkSync(workspaceRoot, symlinkPath);
    try {
      const result = resolveContainedPath(workspaceRoot, "internal-link");
      expect(result).toBe(symlinkPath);
    } finally {
      rmSync(symlinkPath);
    }
  });
});

describe("resolveContainedPathForCreate", () => {
  it("resolves a new file path when parent exists", () => {
    const result = resolveContainedPathForCreate(workspaceRoot, "newfile.txt");
    expect(result).toBe(join(workspaceRoot, "newfile.txt"));
  });

  it("resolves a deeply nested new path (no intermediate dirs exist)", () => {
    const result = resolveContainedPathForCreate(workspaceRoot, "a/b/c/deep.txt");
    expect(result).toBe(join(workspaceRoot, "a/b/c/deep.txt"));
  });

  it("rejects path traversal via ..", () => {
    expect(() => resolveContainedPathForCreate(workspaceRoot, "../../etc/new")).toThrow(
      "Path must stay within workspace root",
    );
  });

  it("rejects an absolute path outside root", () => {
    expect(() => resolveContainedPathForCreate(workspaceRoot, "/tmp/malicious")).toThrow(
      "Path must stay within workspace root",
    );
  });

  it("rejects a symlink that escapes the workspace root", () => {
    const escapeTarget = mkdtempSync(join(tmpdir(), "escape-create-"));
    const symlinkPath = join(workspaceRoot, "create-escape-link");
    symlinkSync(escapeTarget, symlinkPath);
    try {
      expect(() =>
        resolveContainedPathForCreate(workspaceRoot, "create-escape-link/new.txt"),
      ).toThrow("Path escapes workspace root via symlink");
    } finally {
      rmSync(symlinkPath);
      rmSync(escapeTarget, { recursive: true });
    }
  });
});
