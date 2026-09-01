import { realpathSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { Machine } from "@openomni/protocol";

type FsDriver = (request: Machine.FsRequest) => Promise<Machine.FsResult>;
type EntryKind = "file" | "dir" | "symlink" | "other";

function kindOf(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): EntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "dir";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function displayPath(path: string): string {
  return path === "" ? "." : path;
}

function refused(
  reason: Extract<Machine.FsResult, { status: "refused" }>["reason"],
  message: string,
): Machine.FsResult {
  return { status: "refused", reason, message };
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Daemon-local read-only filesystem surface. Export roots are canonicalized
 * once, then every request target is canonicalized and checked again before
 * any operation. That second check is the symlink confinement boundary.
 */
export function createFsDriver(exports: ReadonlyMap<string, string>): FsDriver {
  const roots = new Map<string, string>();
  for (const [name, root] of exports) roots.set(name, realpathSync(root));

  return async (request) => {
    const root = roots.get(request.export);
    if (root === undefined) {
      return refused("export_not_available", `export is not available: ${request.export}`);
    }

    const shown = displayPath(request.path);
    const lexicalTarget = resolve(root, normalize(request.path));
    if (!isWithin(root, lexicalTarget)) {
      return refused("path_escapes_export", `path escapes export: ${shown}`);
    }

    let target: string;
    try {
      target = await realpath(lexicalTarget);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return refused("not_found", `path not found: ${shown}`);
      return refused("io_error", `filesystem operation failed for: ${shown}`);
    }
    if (!isWithin(root, target)) {
      return refused("path_escapes_export", `path escapes export: ${shown}`);
    }

    try {
      if (request.op === "read") {
        const metadata = await stat(target);
        if (!metadata.isFile()) {
          return refused("wrong_kind", `path is not a file: ${shown}`);
        }
        const limit = Math.min(
          request.limit ?? Machine.FS_READ_MAX_BYTES,
          Machine.FS_READ_MAX_BYTES,
        );
        const offset = request.offset ?? 0;
        const handle = await open(target, "r");
        try {
          const buffer = Buffer.alloc(limit);
          const { bytesRead } = await handle.read(buffer, 0, limit, offset);
          const size = (await handle.stat()).size;
          return {
            status: "completed",
            value: {
              op: "read",
              data: buffer.subarray(0, bytesRead).toString("utf8"),
              bytesRead,
              size,
              truncated: offset + bytesRead < size,
            },
          };
        } finally {
          await handle.close();
        }
      }

      if (request.op === "list") {
        const metadata = await stat(target);
        if (!metadata.isDirectory()) {
          return refused("wrong_kind", `path is not a directory: ${shown}`);
        }
        const directoryEntries = (await readdir(target, { withFileTypes: true })).sort(
          (left, right) => left.name.localeCompare(right.name),
        );
        const selected = directoryEntries.slice(0, Machine.FS_LIST_MAX_ENTRIES);
        const entries = await Promise.all(
          selected.map(async (entry) => {
            const entryMetadata = await lstat(join(target, entry.name));
            const kind = kindOf(entryMetadata);
            return kind === "file"
              ? { name: entry.name, kind, size: entryMetadata.size }
              : { name: entry.name, kind };
          }),
        );
        return {
          status: "completed",
          value: {
            op: "list",
            entries,
            truncated: directoryEntries.length > Machine.FS_LIST_MAX_ENTRIES,
          },
        };
      }

      const metadata = await lstat(lexicalTarget);
      return {
        status: "completed",
        value: {
          op: "stat",
          kind: kindOf(metadata),
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        },
      };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return refused("not_found", `path not found: ${shown}`);
      if (isErrno(error, "EISDIR") || isErrno(error, "ENOTDIR")) {
        return refused("wrong_kind", `path has the wrong kind: ${shown}`);
      }
      return refused("io_error", `filesystem operation failed for: ${shown}`);
    }
  };
}
