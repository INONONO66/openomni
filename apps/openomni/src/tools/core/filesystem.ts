import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ToolRefused } from "@openomni/agent";
import { MachineRefusalError, type MachineHost } from "@openomni/machines";
import { parseLocus, type Locus } from "../locus";

export interface FilePorts {
  readonly machines?: Pick<MachineHost, "get">;
}

/** Translate endpoint failures once; authority remains at tool.pre and the daemon. */
export function fileOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: Error) => {
    throw fileRefusal(name, error);
  });
}

/** Refusals pass through; coded I/O errors and daemon refusals become this tool's refusal. */
function fileRefusal(name: string, error: Error): Error {
  if (error instanceof ToolRefused) return error;
  const { code } = error as NodeJS.ErrnoException;
  if (code !== undefined) return new ToolRefused(name, `${code}: ${error.message}`);
  if (error instanceof MachineRefusalError) return new ToolRefused(name, error.data.message);
  return error;
}

export function filesystem(path: string, ports: FilePorts) {
  const locus = parseLocus(path);
  const remote = remoteHost(locus, ports);
  return {
    locus,
    read: () => (remote === undefined ? readFile(locus.path) : remoteRead(remote, locus.path)),
    async write(data: Uint8Array) {
      if (remote !== undefined) return (await remote.fs.write(locus.path, data)).bytesWritten;
      await writeFile(locus.path, data);
      return data.byteLength;
    },
    async list() {
      if (remote !== undefined) return remoteList(remote, locus.path);
      const entries = await readdir(locus.path, { withFileTypes: true });
      return entries
        .map((entry) => ({ name: entry.name, kind: nodeKind(entry) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async kind() {
      if (remote !== undefined) return (await remote.fs.stat(locus.path)).kind;
      return nodeKind(await lstat(locus.path));
    },
  };
}

type Remote = NonNullable<ReturnType<NonNullable<FilePorts["machines"]>["get"]>>;

/** The attached machine a machine locus names; a local locus has none. */
function remoteHost(locus: Locus, ports: FilePorts): Remote | undefined {
  if (locus.kind !== "machine") return undefined;
  const remote = ports.machines?.get(locus.machine);
  if (remote === undefined) throw new ToolRefused("locus", "machine host is not configured");
  return remote;
}

/** The whole file, assembled from the daemon's bounded reads. */
async function remoteRead(remote: Remote, path: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const value = await remote.fs.read(path, { offset });
    chunks.push(value.data);
    offset += value.bytesRead;
    if (!value.truncated) return Buffer.concat(chunks);
    if (value.bytesRead === 0) throw new ToolRefused("read", "remote read made no progress");
  }
}

async function remoteList(remote: Remote, path: string) {
  const value = await remote.fs.list(path);
  if (value.truncated) throw new ToolRefused("ls", "directory exceeds daemon entry limit");
  return value.entries.map(({ name, kind }) => ({ name, kind }));
}

/** One classification for directory entries and lstat results. */
function nodeKind(entry: Pick<Dirent, "isFile" | "isDirectory" | "isSymbolicLink">) {
  if (entry.isFile()) return "file" as const;
  if (entry.isDirectory()) return "dir" as const;
  return entry.isSymbolicLink() ? ("symlink" as const) : ("other" as const);
}

type Endpoint = ReturnType<typeof filesystem>;
type EntryKind = "file" | "dir";
/** Called once per visited path; false stops the walk. Readers open the path themselves. */
type Visit = (path: string, kind: EntryKind) => Promise<boolean>;

/**
 * Depth-first walk in name order without following symlinks: regular files
 * and directories are the only entries visited. Bound to the ports once so a
 * tool builds its walker when it is constructed.
 */
export function walker(ports: FilePorts) {
  async function step(path: string, signal: AbortSignal, visit: Visit): Promise<boolean> {
    signal.throwIfAborted();
    const endpoint = filesystem(path, ports);
    const kind = await entryKind(endpoint);
    if (!(await visit(path, kind))) return false;
    return kind === "file" || descend(endpoint, signal, visit);
  }
  async function descend(endpoint: Endpoint, signal: AbortSignal, visit: Visit): Promise<boolean> {
    const entries = await endpoint.list();
    for (const entry of entries.filter((entry) => entry.kind === "file" || entry.kind === "dir"))
      if (!(await step(childPath(endpoint.locus, entry.name), signal, visit))) return false;
    return true;
  }
  return step;
}

async function entryKind(endpoint: Endpoint): Promise<EntryKind> {
  const kind = await endpoint.kind();
  if (kind === "file" || kind === "dir") return kind;
  throw new ToolRefused("walk", "expected a regular file or directory");
}

function childPath(locus: Locus, name: string): string {
  const path = join(locus.path, name);
  if (locus.kind === "machine") return `${locus.machine}:${path}`;
  // join removes './'; restore the local escape before a child is parsed again.
  return isAbsolute(path) ? path : `./${path}`;
}

export function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolRefused("text", "file is not valid UTF-8; use read with base64 encoding");
  }
}
