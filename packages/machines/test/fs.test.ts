import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@openomni/protocol";
import { createFsDriver } from "../src/fs";

function withFixture(run: (fixture: { base: string; root: string; outside: string }) => Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "openomni-machine-fs-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return run({ base, root, outside }).finally(() => rmSync(base, { recursive: true, force: true }));
}

describe("machine fs request boundary", () => {
  test.each(["/etc/passwd", "../secret", "dir/../secret", "nul\0byte"])(
    "rejects non-relative or escaping path %p",
    (path) => {
      const parsed = Machine.FsRequest.safeParse({ op: "stat", export: "docs", path });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("expected the fs path schema to refuse the request");
      expect(parsed.error.issues[0]?.message).toBe(
        "path must be relative to the export root, with no .. segment or NUL",
      );
    },
  );
});

describe("daemon filesystem driver", () => {
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
      expect(result.value.entries.every((entry) => entry.kind === "file" || entry.size === undefined)).toBe(
        true,
      );
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
