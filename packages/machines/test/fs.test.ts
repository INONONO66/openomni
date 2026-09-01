import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Machine } from "@openomni/protocol";
import { createFsDriver } from "../src/fs";

function withFixture(
  run: (fixture: { base: string; root: string; outside: string }) => Promise<void>,
) {
  const base = mkdtempSync(join(tmpdir(), "openomni-machine-fs-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return run({ base, root, outside }).finally(() => rmSync(base, { recursive: true, force: true }));
}

function runFifoRequest(root: string, request: Machine.FsRequest): string {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "../src/fs.ts")).href;
  const script = `
    import { createFsDriver } from ${JSON.stringify(moduleUrl)};
    const driver = createFsDriver(new Map([["docs", ${JSON.stringify(root)}]]));
    const result = await driver(${JSON.stringify(request)});
    driver.close();
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  return child.stdout;
}

describe("machine fs request boundary", () => {
  test.each([
    "/etc/passwd",
    "../secret",
    "dir/../secret",
    "nul\0byte",
  ])("rejects non-relative or escaping path %p", (path) => {
    const parsed = Machine.FsRequest.safeParse({ op: "stat", export: "docs", path });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected the fs path schema to refuse the request");
    expect(parsed.error.issues[0]?.message).toBe(
      "path must be relative to the export root, with no .. segment or NUL",
    );
  });
});

describe("daemon filesystem driver", () => {
  test("rejects a schema-bypassing lexical escape at the driver boundary", async () => {
    await withFixture(async ({ root }) => {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      const request: Machine.FsRequest = { op: "stat", export: "docs", path: "../secret" };

      await expect(fsOp(request)).resolves.toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: ../secret",
      });
    });
  });

  // Regression guard, not an exploit repro: ".." inside a link target is walked
  // component-wise through openat, so the kernel resolves it after following the
  // link and canonicalPath stays in agreement with the pinned descriptor. This
  // pins that agreement so a future switch to lexical-only resolution is caught.
  test("resolves an export root reached through an absolute link containing ..", async () => {
    await withFixture(async ({ base, root }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      // link -> /<base>/outside/../root, which normalizes back to root.
      const link = join(base, "link");
      symlinkSync(join(base, "outside", "..", "root"), link);

      const fsOp = createFsDriver(new Map([["docs", link]]));
      try {
        await expect(fsOp({ op: "read", export: "docs", path: "note.txt" })).resolves.toMatchObject(
          { status: "completed", value: { op: "read", data: "inside" } },
        );
      } finally {
        fsOp.close();
      }
    });
  });

  test("pins the resolved export root before its pathname can be replaced", async () => {
    await withFixture(async ({ base, root, outside }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      writeFileSync(join(outside, "note.txt"), "outside");
      let swapped = false;
      const fsOp = createFsDriver(new Map([["docs", root]]), {
        afterRootPathResolution: () => {
          renameSync(root, join(base, "original-root"));
          symlinkSync(outside, root);
          swapped = true;
        },
      });

      expect(swapped).toBe(true);
      await expect(fsOp({ op: "read", export: "docs", path: "note.txt" })).resolves.toEqual({
        status: "completed",
        value: {
          op: "read",
          data: "inside",
          bytesRead: 6,
          size: 6,
          truncated: false,
        },
      });
      fsOp.close();
    });
  });

  test("keeps using the opened export inode after its pathname is replaced", async () => {
    await withFixture(async ({ base, root, outside }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      writeFileSync(join(outside, "note.txt"), "outside");
      const fsOp = createFsDriver(new Map([["docs", root]]));
      renameSync(root, join(base, "original-root"));
      symlinkSync(outside, root);

      await expect(fsOp({ op: "read", export: "docs", path: "note.txt" })).resolves.toEqual({
        status: "completed",
        value: {
          op: "read",
          data: "inside",
          bytesRead: 6,
          size: 6,
          truncated: false,
        },
      });
    });
  });

  test("refuses dangling outside symlinks without revealing target existence", async () => {
    await withFixture(async ({ root, outside }) => {
      symlinkSync(join(outside, "missing.txt"), join(root, "escape"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expect(fsOp({ op: "read", export: "docs", path: "escape" })).resolves.toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: escape",
      });
    });
  });

  test("does not confuse an export path with a sibling sharing its prefix", async () => {
    const base = mkdtempSync(join(tmpdir(), "openomni-machine-fs-prefix-"));
    const root = join(base, "export");
    const evil = join(base, "export-evil");
    mkdirSync(root);
    mkdirSync(evil);
    writeFileSync(join(evil, "secret.txt"), "secret");
    symlinkSync(join(evil, "secret.txt"), join(root, "escape"));
    try {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      await expect(fsOp({ op: "read", export: "docs", path: "escape" })).resolves.toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: escape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("canonicalizes an export root symlink before opening its directory", async () => {
    await withFixture(async ({ base, root }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      const rootAlias = join(base, "root-alias");
      symlinkSync(root, rootAlias);
      const fsOp = createFsDriver(new Map([["docs", rootAlias]]));

      await expect(fsOp({ op: "read", export: "docs", path: "note.txt" })).resolves.toMatchObject({
        status: "completed",
        value: { op: "read", data: "inside" },
      });
    });
  });

  test("re-evaluates a component replaced by an outside symlink between calls", async () => {
    await withFixture(async ({ root, outside }) => {
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "inside");
      writeFileSync(join(outside, "secret.txt"), "outside");
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const first = await fsOp({ op: "read", export: "docs", path: "victim.txt" });
      expect(first).toMatchObject({ status: "completed", value: { op: "read", data: "inside" } });
      rmSync(victim);
      symlinkSync(join(outside, "secret.txt"), victim);
      await expect(fsOp({ op: "read", export: "docs", path: "victim.txt" })).resolves.toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: victim.txt",
      });
    });
  });

  test("refuses an unknown export", async () => {
    await withFixture(async ({ root }) => {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      await expect(fsOp({ op: "stat", export: "private", path: "" })).resolves.toEqual({
        status: "refused",
        reason: "export_not_available",
        message: "export is not available: private",
      });
    });
  });

  test("refuses a symlink that resolves outside the export without leaking host paths", async () => {
    await withFixture(async ({ root, outside }) => {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(join(outside, "secret.txt"), join(root, "escape"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const result = await fsOp({ op: "read", export: "docs", path: "escape" });
      expect(result).toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: escape",
      });
      expect(JSON.stringify(result)).not.toContain(outside);
    });
  });

  test("allows a symlink whose target remains inside the export", async () => {
    await withFixture(async ({ root }) => {
      writeFileSync(join(root, "target.txt"), "inside");
      symlinkSync("target.txt", join(root, "link.txt"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expect(fsOp({ op: "read", export: "docs", path: "link.txt" })).resolves.toEqual({
        status: "completed",
        value: {
          op: "read",
          data: "inside",
          bytesRead: 6,
          size: 6,
          truncated: false,
        },
      });
      const stat = await fsOp({ op: "stat", export: "docs", path: "link.txt" });
      expect(stat.status === "completed" && stat.value).toMatchObject({
        op: "stat",
        kind: "symlink",
      });
    });
  });

  test("maps missing paths and wrong kinds to typed refusals", async () => {
    await withFixture(async ({ root }) => {
      mkdirSync(join(root, "folder"));
      writeFileSync(join(root, "file.txt"), "text");
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expect(fsOp({ op: "stat", export: "docs", path: "missing" })).resolves.toEqual({
        status: "refused",
        reason: "not_found",
        message: "path not found: missing",
      });
      await expect(fsOp({ op: "read", export: "docs", path: "folder" })).resolves.toEqual({
        status: "refused",
        reason: "wrong_kind",
        message: "path is not a file: folder",
      });
      await expect(fsOp({ op: "list", export: "docs", path: "file.txt" })).resolves.toEqual({
        status: "refused",
        reason: "wrong_kind",
        message: "path is not a directory: file.txt",
      });
    });
  });

  test("clamps reads to the protocol byte cap and reports an honest range", async () => {
    await withFixture(async ({ root }) => {
      const bytes = Buffer.alloc(Machine.FS_READ_MAX_BYTES + 7, 97);
      writeFileSync(join(root, "large.txt"), bytes);
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const result = await fsOp({
        op: "read",
        export: "docs",
        path: "large.txt",
        limit: Machine.FS_READ_MAX_BYTES + 100,
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed" || result.value.op !== "read") {
        throw new Error("expected a completed read");
      }
      expect(result.value.data.length).toBe(Machine.FS_READ_MAX_BYTES);
      expect(result.value).toMatchObject({
        bytesRead: Machine.FS_READ_MAX_BYTES,
        size: Machine.FS_READ_MAX_BYTES + 7,
        truncated: true,
      });
    });
  });

  test("caps directory listings, reports truncation, and sizes only files", async () => {
    await withFixture(async ({ root }) => {
      for (let index = 0; index < Machine.FS_LIST_MAX_ENTRIES + 1; index += 1) {
        writeFileSync(join(root, `entry-${String(index).padStart(4, "0")}`), "x");
      }
      mkdirSync(join(root, "000-directory"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const result = await fsOp({ op: "list", export: "docs", path: "" });
      expect(result.status).toBe("completed");
      if (result.status !== "completed" || result.value.op !== "list") {
        throw new Error("expected a completed listing");
      }
      expect(result.value.entries).toHaveLength(Machine.FS_LIST_MAX_ENTRIES);
      expect(result.value.truncated).toBe(true);
      expect(result.value.entries.every((entry) => entry.kind !== "file" || entry.size === 1)).toBe(
        true,
      );
      expect(
        result.value.entries.every((entry) => entry.kind === "file" || entry.size === undefined),
      ).toBe(true);
    });
  });

  test("handles FIFOs without blocking read, stat, or list", async () => {
    await withFixture(async ({ root }) => {
      const fifo = join(root, "pipe");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      expect(created.error).toBeUndefined();
      expect(created.signal).toBeNull();
      expect(created.status).toBe(0);
      expect(created.stdout).toBe("");
      expect(created.stderr).toBe("");

      expect(runFifoRequest(root, { op: "read", export: "docs", path: "pipe" })).toBe(
        JSON.stringify({
          status: "refused",
          reason: "wrong_kind",
          message: "path is not a file: pipe",
        }),
      );
      expect(runFifoRequest(root, { op: "stat", export: "docs", path: "pipe" })).toBe(
        JSON.stringify({
          status: "completed",
          value: { op: "stat", kind: "other", size: 0, mtimeMs: lstatSync(fifo).mtimeMs },
        }),
      );
      expect(runFifoRequest(root, { op: "list", export: "docs", path: "" })).toBe(
        JSON.stringify({
          status: "completed",
          value: { op: "list", entries: [{ name: "pipe", kind: "other" }], truncated: false },
        }),
      );
    });
  });

  // A unix socket cannot be opened at all (ENXIO/EOPNOTSUPP), unlike a FIFO
  // which opens under O_NONBLOCK. An export holding one must still list.
  test("lists a directory containing a unix socket", async () => {
    await withFixture(async ({ root }) => {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      const server = createServer();
      await new Promise<void>((ready) => server.listen(join(root, "sock"), ready));
      try {
        await expect(fsOp({ op: "list", export: "docs", path: "" })).resolves.toEqual({
          status: "completed",
          value: {
            op: "list",
            entries: [{ name: "sock", kind: "other" }],
            truncated: false,
          },
        });
        // A socket cannot be opened at all, so the refusal surfaces as io_error
        // rather than wrong_kind: the driver never gets a descriptor to classify.
        await expect(fsOp({ op: "read", export: "docs", path: "sock" })).resolves.toEqual({
          status: "refused",
          reason: "io_error",
          message: "filesystem operation failed for: sock",
        });
      } finally {
        await new Promise<void>((closed) => server.close(() => closed()));

      }
    });
  });

  test("stats files with lstat metadata", async () => {
    await withFixture(async ({ root }) => {
      const path = join(root, "note.txt");
      writeFileSync(path, "hello");
      const expected = lstatSync(path);
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expect(fsOp({ op: "stat", export: "docs", path: "note.txt" })).resolves.toEqual({
        status: "completed",
        value: { op: "stat", kind: "file", size: 5, mtimeMs: expected.mtimeMs },
      });
    });
  });
});
