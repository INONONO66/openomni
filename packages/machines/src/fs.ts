import { CString, FFIType, dlopen, toArrayBuffer, type Pointer } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Machine } from "@openomni/protocol";

type EntryKind = "file" | "dir" | "symlink" | "other";
type Refusal = Extract<Machine.FsResult, { status: "refused" }>;
type OpenedTarget = { readonly fd: number; readonly symlinkStat?: ReturnType<typeof fstatSync> };
type WalkResult = OpenedTarget | Refusal;

export type FsDriver = ((request: Machine.FsRequest) => Promise<Machine.FsResult>) & {
  close(): void;
};

type Root = {
  readonly canonicalPath: string;
  readonly fd: number;
};

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  openat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  readlinkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  ...(process.platform === "darwin"
    ? { __error: { args: [], returns: FFIType.ptr } }
    : { __errno_location: { args: [], returns: FFIType.ptr } }),
});

const O_DIRECTORY = constants.O_DIRECTORY;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_CLOEXEC = process.platform === "darwin" ? 0x100_0000 : 0x8_0000;
const O_OPEN_SYMLINK = process.platform === "darwin" ? 0x20_0000 : 0x20_0000 | O_NOFOLLOW;
const MAX_SYMLINK_EXPANSIONS = 40;
const READLINK_BUFFER_BYTES = 4096;

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function errno(): number {
  const symbols = libc.symbols as typeof libc.symbols & {
    __error?: () => Pointer | null;
    __errno_location?: () => Pointer | null;
  };
  const pointer = symbols.__error?.() ?? symbols.__errno_location?.();
  if (pointer === null || pointer === undefined) return 0;
  return new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true);
}

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

function refused(reason: Refusal["reason"], message: string): Refusal {
  return { status: "refused", reason, message };
}

function isRefusal(result: WalkResult): result is Refusal {
  return "status" in result;
}

function requestSegments(path: string): string[] | undefined {
  if (isAbsolute(path) || path.includes("\0")) return undefined;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? undefined : segments;
}

function resolveLink(
  root: Root,
  traversed: readonly string[],
  target: string,
): string[] | undefined {
  if (isAbsolute(target)) {
    const normalized = resolve(target);
    if (!isWithin(root.canonicalPath, normalized)) return undefined;
    const remainder = relative(root.canonicalPath, normalized);
    return remainder === "" ? [] : remainder.split(sep);
  }

  const resolved = [...traversed];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return undefined;
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved;
}

function readLinkAt(dirfd: number, name: string): { target: string } | { errno: number } {
  const buffer = Buffer.allocUnsafe(READLINK_BUFFER_BYTES);
  const length = Number(
    libc.symbols.readlinkat(dirfd, cString(name), buffer, BigInt(buffer.byteLength)),
  );
  if (length < 0) return { errno: errno() };
  if (length === buffer.byteLength) return { errno: 0 };
  return { target: buffer.subarray(0, length).toString("utf8") };
}

function openAt(dirfd: number, name: string, flags: number): { fd: number } | { errno: number } {
  const fd = libc.symbols.openat(dirfd, cString(name), flags, 0);
  return fd < 0 ? { errno: errno() } : { fd };
}

function openSymlinkAt(dirfd: number, name: string): number | undefined {
  const opened = openAt(dirfd, name, O_OPEN_SYMLINK | O_CLOEXEC);
  if (!("fd" in opened)) return undefined;
  const metadata = fstatSync(opened.fd);
  if (metadata.isSymbolicLink()) return opened.fd;
  closeSync(opened.fd);
  return undefined;
}

function refusalForOpenError(errorNumber: number, shown: string): Refusal {
  if (errorNumber === 2 || errorNumber === 20) {
    return refused("not_found", `path not found: ${shown}`);
  }
  return refused("io_error", `filesystem operation failed for: ${shown}`);
}

function walk(
  root: Root,
  initialSegments: readonly string[],
  finalDirectory: boolean,
  preserveFinalSymlink: boolean,
  shown: string,
): WalkResult {
  let pending = [...initialSegments];
  let traversed: string[] = [];
  let dirfd = root.fd;
  let ownsDirfd = false;
  let expansions = 0;
  let preservedSymlinkFd: number | undefined;

  const closeOwned = () => {
    if (ownsDirfd) closeSync(dirfd);
    ownsDirfd = false;
    dirfd = root.fd;
  };
  const fail = (result: Refusal): Refusal => {
    closeOwned();
    if (preservedSymlinkFd !== undefined) closeSync(preservedSymlinkFd);
    return result;
  };

  while (true) {
    if (pending.length === 0) {
      const opened = openAt(
        dirfd,
        ".",
        constants.O_RDONLY | O_CLOEXEC | (finalDirectory ? O_DIRECTORY : 0),
      );
      if (!("fd" in opened)) return fail(refusalForOpenError(opened.errno, shown));
      closeOwned();
      const symlinkStat =
        preservedSymlinkFd === undefined ? undefined : fstatSync(preservedSymlinkFd);
      if (preservedSymlinkFd !== undefined) closeSync(preservedSymlinkFd);
      return { fd: opened.fd, symlinkStat };
    }

    const segment = pending[0] as string;
    const isFinal = pending.length === 1;
    const flags =
      constants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (!isFinal || finalDirectory ? O_DIRECTORY : 0);
    const opened = openAt(dirfd, segment, flags);
    if ("fd" in opened) {
      closeOwned();
      dirfd = opened.fd;
      ownsDirfd = true;
      traversed.push(segment);
      pending.shift();
      if (pending.length === 0) {
        const symlinkStat =
          preservedSymlinkFd === undefined ? undefined : fstatSync(preservedSymlinkFd);
        if (preservedSymlinkFd !== undefined) closeSync(preservedSymlinkFd);
        return { fd: dirfd, symlinkStat };
      }
      continue;
    }

    const link = readLinkAt(dirfd, segment);
    if (!("target" in link)) {
      if (isFinal && finalDirectory && opened.errno === 20) {
        return fail(refused("wrong_kind", `path is not a directory: ${shown}`));
      }
      return fail(refusalForOpenError(opened.errno, shown));
    }

    const rewritten = resolveLink(root, traversed, link.target);
    if (rewritten === undefined) {
      return fail(refused("path_escapes_export", `path escapes export: ${shown}`));
    }
    expansions += 1;
    if (expansions > MAX_SYMLINK_EXPANSIONS) {
      return fail(refused("io_error", `filesystem operation failed for: ${shown}`));
    }

    if (isFinal && preserveFinalSymlink && preservedSymlinkFd === undefined) {
      preservedSymlinkFd = openSymlinkAt(dirfd, segment);
      if (preservedSymlinkFd === undefined) {
        return fail(refused("io_error", `filesystem operation failed for: ${shown}`));
      }
    }

    pending = [...rewritten, ...pending.slice(1)];
    traversed = [];
    closeOwned();
  }
}

function directoryNames(fd: number): string[] {
  const duplicate = openAt(fd, ".", constants.O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (!("fd" in duplicate)) throw new Error("directory duplication failed");
  const directory = libc.symbols.fdopendir(duplicate.fd);
  if (directory === null) {
    closeSync(duplicate.fd);
    throw new Error("fdopendir failed");
  }
  const names: string[] = [];
  try {
    while (true) {
      const entry = libc.symbols.readdir(directory);
      if (entry === null) break;
      const name =
        process.platform === "darwin"
          ? new CString(
              entry,
              21,
              new DataView(toArrayBuffer(entry, 0, 20)).getUint16(18, true),
            ).toString()
          : new CString(entry, 19).toString();
      if (name !== "." && name !== "..") names.push(name);
    }
  } finally {
    libc.symbols.closedir(directory);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function entryAt(dirfd: number, name: string): { name: string; kind: EntryKind; size?: number } {
  const opened = openAt(dirfd, name, constants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if ("fd" in opened) {
    try {
      const metadata = fstatSync(opened.fd);
      const kind = kindOf(metadata);
      return kind === "file" ? { name, kind, size: metadata.size } : { name, kind };
    } finally {
      closeSync(opened.fd);
    }
  }
  const link = readLinkAt(dirfd, name);
  if ("target" in link) return { name, kind: "symlink" };
  throw new Error("directory entry disappeared");
}

/**
 * Daemon-local read-only filesystem surface. Each canonical export root is
 * opened once, and requests walk from that descriptor with openat(O_NOFOLLOW).
 * Symlinks are expanded lexically and every expansion restarts at the root fd,
 * so no pathname is checked and then resolved again for use.
 */
export function createFsDriver(exports: ReadonlyMap<string, string>): FsDriver {
  const roots = new Map<string, Root>();
  try {
    for (const [name, configuredRoot] of exports) {
      const canonicalPath = realpathSync(configuredRoot);
      roots.set(name, {
        canonicalPath,
        fd: openSync(canonicalPath, constants.O_RDONLY | O_DIRECTORY | O_CLOEXEC),
      });
    }
  } catch (error) {
    for (const root of roots.values()) closeSync(root.fd);
    throw error;
  }

  let closed = false;
  const driver = (async (request: Machine.FsRequest): Promise<Machine.FsResult> => {
    const root = roots.get(request.export);
    if (root === undefined) {
      return refused("export_not_available", `export is not available: ${request.export}`);
    }

    const shown = displayPath(request.path);
    const segments = requestSegments(request.path);
    if (segments === undefined) {
      return refused("path_escapes_export", `path escapes export: ${shown}`);
    }

    const target = walk(root, segments, request.op === "list", request.op === "stat", shown);
    if (isRefusal(target)) return target;

    try {
      if (request.op === "read") {
        const metadata = fstatSync(target.fd);
        if (!metadata.isFile()) return refused("wrong_kind", `path is not a file: ${shown}`);
        const limit = Math.min(
          request.limit ?? Machine.FS_READ_MAX_BYTES,
          Machine.FS_READ_MAX_BYTES,
        );
        const offset = request.offset ?? 0;
        const buffer = Buffer.alloc(limit);
        const bytesRead = readSync(target.fd, buffer, 0, limit, offset);
        return {
          status: "completed",
          value: {
            op: "read",
            data: buffer.subarray(0, bytesRead).toString("utf8"),
            bytesRead,
            size: metadata.size,
            truncated: offset + bytesRead < metadata.size,
          },
        };
      }

      if (request.op === "list") {
        const directoryEntries = directoryNames(target.fd);
        const selected = directoryEntries.slice(0, Machine.FS_LIST_MAX_ENTRIES);
        return {
          status: "completed",
          value: {
            op: "list",
            entries: selected.map((name) => entryAt(target.fd, name)),
            truncated: directoryEntries.length > Machine.FS_LIST_MAX_ENTRIES,
          },
        };
      }

      const metadata = target.symlinkStat ?? fstatSync(target.fd);
      return {
        status: "completed",
        value: {
          op: "stat",
          kind: kindOf(metadata),
          size: Number(metadata.size),
          mtimeMs: Number(metadata.mtimeMs),
        },
      };
    } catch {
      return refused("io_error", `filesystem operation failed for: ${shown}`);
    } finally {
      closeSync(target.fd);
    }
  }) as FsDriver;

  driver.close = () => {
    if (closed) return;
    closed = true;
    for (const root of roots.values()) closeSync(root.fd);
    roots.clear();
  };
  return driver;
}
