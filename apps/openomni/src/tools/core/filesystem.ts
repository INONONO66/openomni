import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ToolRefused } from "@openomni/agent";
import { MachineRefusalError, type MachineHost } from "@openomni/machines";
import { parseLocus, type Locus } from "../locus";

export interface FilePorts {
  readonly machines?: Pick<MachineHost, "get">;
}

/** Translate endpoint failures once; authority remains at tool.pre and the daemon. */
export async function fileOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ToolRefused) throw error;
    if (error instanceof Error && "code" in error)
      throw new ToolRefused(name, `${String(error.code)}: ${error.message}`);
    if (MachineRefusalError.isInstance(error)) throw new ToolRefused(name, error.data.message);
    throw error;
  }
}

export function filesystem(path: string, ports: FilePorts) {
  const locus = parseLocus(path);
  const remote = locus.kind === "machine" ? ports.machines?.get(locus.machine) : undefined;
  if (locus.kind === "machine" && remote === undefined)
    throw new ToolRefused("locus", "machine host is not configured");
  return {
    locus,
    async read() {
      if (remote === undefined) return readFile(locus.path);
      const chunks: Uint8Array[] = [];
      let offset = 0;
      for (;;) {
        const value = await remote.fs.read(locus.path, { offset });
        chunks.push(value.data);
        offset += value.bytesRead;
        if (!value.truncated) return Buffer.concat(chunks);
        if (value.bytesRead === 0) throw new ToolRefused("read", "remote read made no progress");
      }
    },
    async write(data: Uint8Array) {
      if (remote !== undefined) return (await remote.fs.write(locus.path, data)).bytesWritten;
      await writeFile(locus.path, data);
      return data.byteLength;
    },
    async list() {
      if (remote !== undefined) {
        const value = await remote.fs.list(locus.path);
        if (value.truncated) throw new ToolRefused("ls", "directory exceeds daemon entry limit");
        return value.entries.map(({ name, kind }) => ({ name, kind }));
      }
      const entries = await readdir(locus.path, { withFileTypes: true });
      return entries
        .map((entry) => ({
          name: entry.name,
          kind: entry.isFile()
            ? ("file" as const)
            : entry.isDirectory()
              ? ("dir" as const)
              : entry.isSymbolicLink()
                ? ("symlink" as const)
                : ("other" as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async kind() {
      if (remote !== undefined) return (await remote.fs.stat(locus.path)).kind;
      const value = await lstat(locus.path);
      return value.isFile()
        ? "file"
        : value.isDirectory()
          ? "dir"
          : value.isSymbolicLink()
            ? "symlink"
            : "other";
    },
  };
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
