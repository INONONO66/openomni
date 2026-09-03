import { CString, FFIType, dlopen, toArrayBuffer, type Pointer } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Machine } from "@openomni/protocol";

type EntryKind = "file" | "dir" | "symlink" | "other";
type Refusal = Extract<Machine.FsResult, { status: "refused" }>;
type OpenedTarget = { readonly fd: number; readonly symlinkStat?: ReturnType<typeof fstatSync> };
type WalkResult = OpenedTarget | Refusal;

export type FsDriver = ((request: Machine.FsRequest) => Promise<Machine.FsResult>) & {
  close(): void;
};

type FsDriverTestHooks = {
  readonly afterRootPathResolution?: (canonicalPath: string) => void;
  /**
   * Seams over the root descriptor lifecycle. A test substitutes the open of
   * the filesystem root to force the restart reopen to fail, and observes
   * acquisition and release of every descriptor the root walk owns, so the
   * close-exactly-once invariant is asserted without depending on permissions,
   * fd exhaustion, or timing.
   */
  readonly openRootDirectory?: () => number;
  readonly onRootDescriptorAcquired?: (fd: number) => void;
  readonly closeRootDescriptor?: (fd: number) => void;
};

type RootWalk = { readonly canonicalPath: string; readonly fd: number };

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
/**
 * Every descriptor this driver opens is opened non-blocking. A regular file or
 * directory is unaffected, while a FIFO or device node in an export would
 * otherwise park the daemon inside open(2) until a writer appeared.
 */
const O_TARGET = constants.O_RDONLY | constants.O_NONBLOCK;
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
        O_TARGET | O_CLOEXEC | (finalDirectory ? O_DIRECTORY : 0),
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
      (isFinal ? O_TARGET : constants.O_RDONLY) |
      O_NOFOLLOW |
      O_CLOEXEC |
      (!isFinal || finalDirectory ? O_DIRECTORY : 0);
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

function closeRootDescriptor(testHooks: FsDriverTestHooks, fd: number): void {
  if (testHooks.closeRootDescriptor === undefined) closeSync(fd);
  else testHooks.closeRootDescriptor(fd);
}

/**
 * Resolve an Owner-configured export root into a pinned descriptor by walking
 * its components with openat(O_NOFOLLOW) from the filesystem root, expanding
 * any symlink component explicitly and restarting the walk. The canonical path
 * is recorded from the components actually traversed, so the descriptor and the
 * recorded path are produced by one traversal instead of a resolution that is
 * verified and then re-resolved by name when the descriptor is opened.
 */
function openRoot(configuredRoot: string, testHooks: FsDriverTestHooks): RootWalk {
  const absolute = resolve(configuredRoot);
  let pending = absolute.split(sep).filter((segment) => segment.length > 0);
  let traversed: string[] = [];
  let expansions = 0;
  /**
   * `owned` is the sole owner of the walk descriptor: it holds an fd only
   * while that fd is open, and `release()` clears it BEFORE closing. No
   * failure path can therefore close a released fd a second time — by then a
   * reused fd number belongs to an unrelated open, and the secondary close
   * would also mask the failure that caused the unwind. The walk reads the
   * held fd through `dirfd`, which every acquisition rebinds in the same step.
   */
  let owned: number | undefined;

  const acquire = (fd: number): number => {
    testHooks.onRootDescriptorAcquired?.(fd);
    owned = fd;
    return fd;
  };
  const openFilesystemRoot = () =>
    acquire(
      testHooks.openRootDirectory === undefined
        ? openSync(sep, constants.O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        : testHooks.openRootDirectory(),
    );
  const release = () => {
    if (owned === undefined) return;
    const fd = owned;
    owned = undefined;
    closeRootDescriptor(testHooks, fd);
  };

  let dirfd = openFilesystemRoot();

  try {
    while (pending.length > 0) {
      const segment = pending[0] as string;
      const opened = openAt(
        dirfd,
        segment,
        constants.O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC,
      );
      if ("fd" in opened) {
        release();
        dirfd = acquire(opened.fd);
        traversed.push(segment);
        pending.shift();
        continue;
      }

      const link = readLinkAt(dirfd, segment);
      if (!("target" in link)) {
        throw new Error(`export root is not a directory: ${configuredRoot}`);
      }
      expansions += 1;
      if (expansions > MAX_SYMLINK_EXPANSIONS) {
        throw new Error(`export root has too many symlink levels: ${configuredRoot}`);
      }
      // Both branches must be lexically normalized. An absolute target may
      // still carry "."/".." components, and leaving them raw makes
      // canonicalPath disagree with the pinned descriptor, which then breaks
      // containment comparisons in resolveLink().
      const linkBase = resolve(
        isAbsolute(link.target) ? sep : sep + traversed.join(sep),
        link.target,
      );
      pending = [
        ...linkBase.split(sep).filter((segment_) => segment_.length > 0),
        ...pending.slice(1),
      ];
      traversed = [];
      release();
      dirfd = openFilesystemRoot();
    }
  } catch (error) {
    release();
    throw error;
  }

  const canonicalPath = sep + traversed.join(sep);
  testHooks.afterRootPathResolution?.(canonicalPath);
  // Past the walk, ownership of the pinned descriptor belongs to the returned
  // root: the driver closes it on disposal, and `release()` is out of reach.
  return { canonicalPath, fd: dirfd };
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
  const opened = openAt(dirfd, name, O_TARGET | O_NOFOLLOW | O_CLOEXEC);
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
  // Sockets, devices and other non-openable nodes reach here: O_NOFOLLOW open
  // fails and the entry is not a symlink. They are listable but unreadable, so
  // report them as "other" instead of failing the whole listing. A read of one
  // is refused wrong_kind on its own path.
  return { name, kind: "other" };
}

/**
 * Daemon-local read-only filesystem surface. Each canonical export root is
 * opened once, and requests walk from that descriptor with openat(O_NOFOLLOW).
 * Symlinks are expanded lexically and every expansion restarts at the root fd,
 * so no pathname is checked and then resolved again for use.
 */
export function createFsDriver(
  exports: ReadonlyMap<string, string>,
  testHooks: FsDriverTestHooks = {},
): FsDriver {
  const roots = new Map<string, Root>();
  try {
    for (const [name, configuredRoot] of exports) {
      roots.set(name, openRoot(configuredRoot, testHooks));
    }
  } catch (error) {
    for (const root of roots.values()) closeRootDescriptor(testHooks, root.fd);
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
    for (const root of roots.values()) closeRootDescriptor(testHooks, root.fd);
    roots.clear();
  };
  return driver;
}
