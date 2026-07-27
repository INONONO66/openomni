import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  WorkspaceIdentityDeniedError,
  assertWorkspaceIdentity,
  createWorkspaceIdentity,
  createWorkspaceIdentityForTest,
  resolveWorkspaceTarget,
  revalidateWorkspaceTarget,
  toWorkspaceRef,
  type WorkspacePlatformAdapterV1,
} from "../../src/execution-runtime/workspace-identity";

const cleanup: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

function fixtureAdapter(
  canonicalRoot: string,
  overrides: Partial<WorkspacePlatformAdapterV1> = {},
): WorkspacePlatformAdapterV1 {
  return {
    platform: "posix",
    compositionCwd: "/server-cwd",
    path: posix,
    realpath: () => canonicalRoot,
    identity: () => ({ isDirectory: true, volumeId: "7", fileId: "42" }),
    capabilities: () => ({
      caseMode: "case-sensitive",
      unicodeMode: "unicode-preserving",
    }),
    ...overrides,
  };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workspace-v1 identity", () => {
  test("emits the revision-9 canonical bytes byte-for-byte", () => {
    const identity = createWorkspaceIdentity("relative", {
      adapter: fixtureAdapter("/fixture/é"),
    });

    expect(Buffer.from(identity.canonicalBytes()).toString("utf8")).toBe(
      "workspace-v1\n" +
        "platform=posix\n" +
        "path-bytes=11\n" +
        "/fixture/é\n" +
        "volume-id=7\n" +
        "file-id=42\n" +
        "case-mode=case-sensitive\n" +
        "unicode-mode=unicode-preserving\n",
    );
    const callerCopy = identity.canonicalBytes();
    callerCopy[0] = 0;
    expect(Buffer.from(identity.canonicalBytes()).toString("utf8")).toStartWith("workspace-v1\n");
    expect(identity.workspaceId).toBe(`w1:${identity.canonicalBytesDigest}`);
    expect(toWorkspaceRef(identity)).toEqual({
      canonicalizerVersion: "workspace-v1",
      workspaceId: identity.workspaceId,
      canonicalBytesDigest: identity.canonicalBytesDigest,
    });
  });

  test("root aliases share stable object identity", () => {
    const parent = temporaryDirectory("openomni-workspace-parent-");
    const root = join(parent, "CaseSensitiveName");
    const alias = join(parent, "alias");
    mkdirSync(root);
    symlinkSync(root, alias, "dir");

    const direct = createWorkspaceIdentity(root);
    const throughAlias = createWorkspaceIdentity(alias);
    expect(throughAlias.workspaceId).toBe(direct.workspaceId);
    expect(throughAlias.canonicalRoot).toBe(realpathSync(root));
    expect(direct.rootIdentity.volumeId).toMatch(/^\d+$/);
    expect(direct.rootIdentity.fileId).toMatch(/^\d+$/);
  });

  test("preserves a POSIX trailing backslash as a literal directory basename", () => {
    const parent = temporaryDirectory("openomni-workspace-backslash-");
    const root = join(parent, "root");
    const backslashRoot = `${root}\\`;
    mkdirSync(root);
    mkdirSync(backslashRoot);

    const canonicalParent = realpathSync(parent);
    const plain = createWorkspaceIdentity(root);
    const backslash = createWorkspaceIdentity(backslashRoot);
    expect(plain.canonicalRoot).toBe(join(canonicalParent, "root"));
    expect(backslash.canonicalRoot).toBe(join(canonicalParent, "root\\"));
    expect(backslash.workspaceId).not.toBe(plain.workspaceId);
    expect(backslash.canonicalBytesDigest).not.toBe(plain.canonicalBytesDigest);

    const parentWorkspace = createWorkspaceIdentity(parent);
    expect(resolveWorkspaceTarget(parentWorkspace, "root\\", "existing").canonicalTarget).toBe(
      join(canonicalParent, "root\\"),
    );
  });

  test("denies a realpath result whose object identity cannot be recovered literally", () => {
    const adapter = fixtureAdapter("/canonical-parent/root", {
      realpath: (path) => {
        if (path === "/alias/root\\") return "/canonical-parent/root";
        if (path === "/alias") return "/canonical-parent";
        return path;
      },
      identity: (path) => {
        if (path === "/alias/root\\") {
          return { isDirectory: true, volumeId: "1", fileId: "2" };
        }
        if (path === "/canonical-parent/root") {
          return { isDirectory: true, volumeId: "1", fileId: "3" };
        }
        if (path === "/canonical-parent/root\\") {
          return { isDirectory: true, volumeId: "1", fileId: "4" };
        }
        return { isDirectory: true, volumeId: "1", fileId: "5" };
      },
    });

    expect(() => createWorkspaceIdentity("/alias/root\\", { adapter })).toThrow(
      expect.objectContaining({ code: "workspace_identity_unavailable" }),
    );
  });

  test("does not software-fold case or normalize Unicode", () => {
    const upper = createWorkspaceIdentity("/Volume/Root", {
      adapter: fixtureAdapter("/Volume/Root"),
    });
    const lower = createWorkspaceIdentity("/volume/root", {
      adapter: fixtureAdapter("/volume/root"),
    });
    const composed = createWorkspaceIdentity("/Volume/é", {
      adapter: fixtureAdapter("/Volume/é"),
    });
    const decomposed = createWorkspaceIdentity("/Volume/é", {
      adapter: fixtureAdapter("/Volume/é"),
    });

    expect(lower.workspaceId).not.toBe(upper.workspaceId);
    expect(decomposed.workspaceId).not.toBe(composed.workspaceId);
  });

  test("uses adapter-returned aliases on insensitive and normalizing volumes", () => {
    const insensitive = fixtureAdapter("/volume/root", {
      capabilities: () => ({
        caseMode: "case-insensitive",
        unicodeMode: "unicode-normalizing",
      }),
    });
    expect(createWorkspaceIdentity("/VOLUME/ROOT", { adapter: insensitive }).workspaceId).toBe(
      createWorkspaceIdentity("/volume/root", { adapter: insensitive }).workspaceId,
    );
  });

  test("supports an injected Windows stable-ID adapter and fails closed when identity is unavailable", () => {
    const adapter: WorkspacePlatformAdapterV1 = {
      platform: "win32",
      compositionCwd: "C:\\server",
      path: win32,
      realpath: () => "C:\\Workspace",
      identity: () => ({ isDirectory: true, volumeId: "99", fileId: "123456789" }),
      capabilities: () => ({
        caseMode: "case-insensitive",
        unicodeMode: "unicode-preserving",
      }),
    };
    const identity = createWorkspaceIdentity(".\\Workspace", { adapter });
    expect(identity.platform).toBe("win32");
    expect(identity.rootIdentity).toEqual({ volumeId: "99", fileId: "123456789" });

    expect(() =>
      createWorkspaceIdentity("C:\\Workspace", {
        adapter: {
          ...adapter,
          identity: () => {
            throw new Error("adapter unavailable");
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "workspace_identity_unavailable" }));
  });

  test("detects same-ID different-byte collisions and invalidates the earlier identity", () => {
    const forcedDigest = () => "a".repeat(64);
    const first = createWorkspaceIdentityForTest(
      "/collision/one",
      { adapter: fixtureAdapter("/collision/one") },
      forcedDigest,
    );
    expect(() =>
      createWorkspaceIdentityForTest(
        "/collision/two",
        { adapter: fixtureAdapter("/collision/two") },
        forcedDigest,
      ),
    ).toThrow(expect.objectContaining({ code: "workspace_identity_collision" }));
    expect(() => assertWorkspaceIdentity(first)).toThrow(
      expect.objectContaining({ code: "workspace_identity_collision" }),
    );
  });

  test("distinguishes unavailable, moved, and replaced roots", () => {
    const parent = temporaryDirectory("openomni-workspace-revalidation-");
    const root = join(parent, "root");
    const moved = join(parent, "moved");
    mkdirSync(root);
    const replaced = createWorkspaceIdentity(root);
    renameSync(root, moved);
    mkdirSync(root);
    expect(() => assertWorkspaceIdentity(replaced)).toThrow(
      expect.objectContaining({ code: "workspace_root_replaced" }),
    );

    rmSync(root, { recursive: true });
    expect(() => assertWorkspaceIdentity(replaced)).toThrow(
      expect.objectContaining({ code: "workspace_root_unavailable" }),
    );

    let realpath = "/frozen";
    const identity = createWorkspaceIdentity("/frozen", {
      adapter: fixtureAdapter(realpath, { realpath: () => realpath }),
    });
    realpath = "/moved";
    expect(() => assertWorkspaceIdentity(identity)).toThrow(
      expect.objectContaining({ code: "workspace_root_moved" }),
    );
  });
});

describe("workspace-v1 targets", () => {
  test("returns the exact root/ancestor contract for aliases and descendants", () => {
    const parent = temporaryDirectory("openomni-workspace-target-");
    const root = join(parent, "root");
    const existing = join(root, "existing");
    mkdirSync(existing, { recursive: true });
    symlinkSync(existing, join(root, "alias"), "dir");
    const workspace = createWorkspaceIdentity(root);

    const target = resolveWorkspaceTarget(workspace, "alias/new/deeper/file.txt");
    expect(target).toEqual({
      workspaceId: workspace.workspaceId,
      canonicalTarget: join(realpathSync(existing), "new/deeper/file.txt"),
      existingAncestorIdentity: expect.objectContaining({
        volumeId: expect.stringMatching(/^\d+$/),
        fileId: expect.stringMatching(/^\d+$/),
      }),
      unresolvedSuffix: join("new", "deeper", "file.txt"),
      targetMode: "create",
    });
    expect(resolveWorkspaceTarget(workspace, realpathSync(root), "existing").canonicalTarget).toBe(
      realpathSync(root),
    );
  });

  test("rejects traversal, absolute reset escapes, and escaping symlinks", () => {
    const root = temporaryDirectory("openomni-workspace-contained-");
    const outside = temporaryDirectory("openomni-workspace-outside-");
    symlinkSync(outside, join(root, "escape"), "dir");
    const workspace = createWorkspaceIdentity(root);

    expect(() => resolveWorkspaceTarget(workspace, "../escape")).toThrow(
      expect.objectContaining({ code: "workspace_target_escape" }),
    );
    expect(() => resolveWorkspaceTarget(workspace, join(root, "..", "escape"))).toThrow(
      expect.objectContaining({ code: "workspace_target_escape" }),
    );
    expect(() => resolveWorkspaceTarget(workspace, "escape/not-created.txt")).toThrow(
      expect.objectContaining({ code: "workspace_symlink_escape" }),
    );
    expect(() => resolveWorkspaceTarget(workspace, "bad\0path")).toThrow(
      expect.objectContaining({ code: "workspace_target_invalid" }),
    );
  });

  test("accepts a valid injected-Windows descendant and rejects Windows aliases", () => {
    const canonicalRoot = "C:\\Workspace";
    const adapter: WorkspacePlatformAdapterV1 = {
      platform: "win32",
      compositionCwd: "C:\\server",
      path: win32,
      realpath: (path) => {
        if (path.toLowerCase() === canonicalRoot.toLowerCase()) return canonicalRoot;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      identity: () => ({ isDirectory: true, volumeId: "99", fileId: "123456789" }),
      capabilities: () => ({
        caseMode: "case-insensitive",
        unicodeMode: "unicode-preserving",
      }),
    };
    const workspace = createWorkspaceIdentity("C:\\Workspace", { adapter });

    expect(resolveWorkspaceTarget(workspace, "safe\\child.txt")).toEqual({
      workspaceId: workspace.workspaceId,
      canonicalTarget: "C:\\Workspace\\safe\\child.txt",
      existingAncestorIdentity: { volumeId: "99", fileId: "123456789" },
      unresolvedSuffix: "safe\\child.txt",
      targetMode: "create",
    });

    const invalidTargets = [
      "file.txt:stream",
      "C:drive-relative.txt",
      "NUL",
      "nul.txt",
      "PRN.txt",
      "AUX.json",
      "dir\\CON.json",
      "COM1.log",
      "LPT9",
      "COM¹.txt",
      "trailing.",
      "dir\\trailing ",
    ];
    for (const target of invalidTargets) {
      try {
        resolveWorkspaceTarget(workspace, target);
        throw new Error(`expected Windows target denial: ${target}`);
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceIdentityDeniedError);
        expect(error).toEqual(expect.objectContaining({ code: "workspace_target_invalid" }));
      }
    }
  });

  test("detects target replacement or symlink appearance between checks", () => {
    const root = temporaryDirectory("openomni-workspace-race-");
    const workspace = createWorkspaceIdentity(root);
    const prior = resolveWorkspaceTarget(workspace, "target/new.txt");
    mkdirSync(join(root, "target"));
    expect(() => revalidateWorkspaceTarget(workspace, "target/new.txt", prior)).toThrow(
      expect.objectContaining({ code: "workspace_target_changed" }),
    );

    const second = resolveWorkspaceTarget(workspace, "other/new.txt");
    const outside = temporaryDirectory("openomni-workspace-race-outside-");
    symlinkSync(outside, join(root, "other"), "dir");
    expect(() => revalidateWorkspaceTarget(workspace, "other/new.txt", second)).toThrow(
      expect.objectContaining({ code: "workspace_symlink_escape" }),
    );
  });
});
