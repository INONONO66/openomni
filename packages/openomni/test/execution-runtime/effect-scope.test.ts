import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  EffectScopeDeniedError,
  EffectScopeRegistry,
  digestEffectValue,
} from "../../src/execution-runtime/effect-scope";
import {
  createWorkspaceIdentity,
  toWorkspaceRef,
  type WorkspacePlatformAdapterV1,
} from "../../src/execution-runtime/workspace-identity";

const cleanup: string[] = [];

function workspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "openomni-effect-scope-"));
  cleanup.push(root);
  return root;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("EffectScopeRegistry revision-9 contracts", () => {
  test("Bash output is exact, command-independent, and cannot claim containment", () => {
    const workspace = createWorkspaceIdentity(workspaceFixture());
    const registry = new EffectScopeRegistry();

    const destructive = registry.resolve("bash", "1", { command: "rm -rf ." }, { workspace });
    const misleading = registry.resolve(
      "bash",
      "1",
      { command: '# read only\neval "$generated"', workdir: "small" },
      { workspace },
    );

    expect(destructive).toEqual(misleading);
    expect(destructive).toEqual({
      version: "effect-scope-v1",
      workspace: toWorkspaceRef(workspace),
      resources: [{ version: "resource-scope-v1", kind: "workspace", target: "**" }],
      resolver: {
        id: "bash-workspace-v1",
        version: "1",
        inputDigest: digestEffectValue("bash-workspace-v1"),
      },
      containment: "none",
      mutationClass: "unknown",
    });
    expect(Object.isFrozen(destructive)).toBe(true);
    expect(Object.isFrozen(destructive.resources)).toBe(true);
    expect(Object.isFrozen(destructive.resolver)).toBe(true);
  });

  test("Bash is nondowngradable and missing or unregistered scope denies", () => {
    const workspace = createWorkspaceIdentity(workspaceFixture());
    const registry = new EffectScopeRegistry();

    expect(registry.classification("bash", "1")).toBe("unknown");
    expect(() => registry.resolve("bash", "1", { isReadOnly: true }, {})).toThrow(
      expect.objectContaining({ code: "effect_scope_unresolved" }),
    );
    expect(() => registry.resolve("bash", "2", {}, { workspace })).toThrow(EffectScopeDeniedError);
    expect(() => registry.resolve("mcp.dynamic", "1", {}, { workspace })).toThrow(
      expect.objectContaining({ code: "effect_scope_unresolved" }),
    );
    expect("register" in registry).toBe(false);
  });

  test("preserves POSIX backslash directory identity in filesystem scope", () => {
    const parent = workspaceFixture();
    const root = join(parent, "root");
    const backslashRoot = `${root}\\`;
    mkdirSync(root);
    mkdirSync(backslashRoot);
    const workspace = createWorkspaceIdentity(parent);
    const registry = new EffectScopeRegistry();

    const scope = registry.resolve("remove", "1", { path: "root\\" }, { workspace });
    const plainScope = registry.resolve("remove", "1", { path: "root" }, { workspace });
    const canonicalBackslashRoot = join(realpathSync(parent), "root\\");
    expect(scope.workspace).toEqual(toWorkspaceRef(workspace));
    expect(scope.resources[1]).toEqual({
      version: "resource-scope-v1",
      kind: "workspace_path",
      targetDigest: digestEffectValue(canonicalBackslashRoot),
    });
    expect(scope.resources[1]).not.toEqual(plainScope.resources[1]);
    expect(scope.resolver.inputDigest).toBe(
      digestEffectValue(JSON.stringify([canonicalBackslashRoot])),
    );
  });

  test("filesystem mutators bind workspace wildcard plus canonical targets", () => {
    const root = workspaceFixture();
    const existing = join(root, "existing");
    mkdirSync(existing);
    symlinkSync(existing, join(root, "alias"), "dir");
    const workspace = createWorkspaceIdentity(root);
    const registry = new EffectScopeRegistry();

    const scope = registry.resolve("write", "1", { path: "alias/new.txt" }, { workspace });
    expect(scope).toEqual({
      version: "effect-scope-v1",
      workspace: toWorkspaceRef(workspace),
      resources: [
        { version: "resource-scope-v1", kind: "workspace", target: "**" },
        {
          version: "resource-scope-v1",
          kind: "workspace_path",
          targetDigest: digestEffectValue(join(realpathSync(existing), "new.txt")),
        },
      ],
      resolver: {
        id: "filesystem-target-v1",
        version: "1",
        inputDigest: digestEffectValue(JSON.stringify([join(realpathSync(existing), "new.txt")])),
      },
      containment: "filesystem-canonicalized",
      mutationClass: "mutating",
    });

    const rename = registry.resolve(
      "rename",
      "1",
      { from: "alias/old.txt", to: "alias/new.txt" },
      { workspace },
    );
    expect(rename.resources[0]).toEqual({
      version: "resource-scope-v1",
      kind: "workspace",
      target: "**",
    });
    expect(rename.resources).toHaveLength(3);
  });

  test("filesystem escape and symlink escape deny instead of narrowing scope", () => {
    const root = workspaceFixture();
    const outside = workspaceFixture();
    symlinkSync(outside, join(root, "escape"), "dir");
    const workspace = createWorkspaceIdentity(root);
    const registry = new EffectScopeRegistry();

    expect(() => registry.resolve("edit", "1", { path: "../outside" }, { workspace })).toThrow(
      expect.objectContaining({ code: "effect_scope_unresolved" }),
    );
    expect(() => registry.resolve("remove", "1", { path: "escape/file" }, { workspace })).toThrow(
      expect.objectContaining({ code: "effect_scope_unresolved" }),
    );
  });

  test("read-only status exists only for frozen checked IDs", () => {
    const registry = new EffectScopeRegistry();
    const workspace = createWorkspaceIdentity(workspaceFixture());

    expect(registry.isStaticallyReadOnly("read", "1")).toBe(true);
    expect(registry.isStaticallyReadOnly("glob", "1")).toBe(true);
    expect(registry.isStaticallyReadOnly("grep.search", "1")).toBe(true);
    expect(registry.isStaticallyReadOnly("read", "2")).toBe(false);
    expect(registry.isStaticallyReadOnly("custom.read", "1")).toBe(false);
    expect(() => registry.resolve("read", "1", { path: "file" }, { workspace })).toThrow(
      expect.objectContaining({ code: "effect_scope_unresolved" }),
    );
  });

  test("denies nondeterministic resolver output and target replacement", () => {
    let targetRealpaths = 0;
    const adapter: WorkspacePlatformAdapterV1 = {
      platform: "posix",
      compositionCwd: "/",
      path: posix,
      realpath(path) {
        if (path === "/root/file") {
          targetRealpaths += 1;
          return targetRealpaths <= 2 ? "/root/file" : "/root/other";
        }
        return path;
      },
      identity: () => ({ isDirectory: true, volumeId: "1", fileId: "2" }),
      capabilities: () => ({ caseMode: "case-sensitive", unicodeMode: "unicode-preserving" }),
    };
    const workspace = createWorkspaceIdentity("/root", { adapter });
    const registry = new EffectScopeRegistry();

    expect(() => registry.resolve("write", "1", { path: "file" }, { workspace })).toThrow(
      expect.objectContaining({
        code: "effect_scope_unresolved",
        message: expect.stringContaining("nondeterministic"),
      }),
    );
  });
});
