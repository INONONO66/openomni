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

export type Endpoint = ReturnType<typeof filesystem>;

/**
 * Depth-first walk in name order without following symlinks. `visit` returns
 * false to stop early; regular files and directories are the only entries seen.
 */
export async function walk(
  path: string,
  ports: FilePorts,
  signal: AbortSignal,
  visit: (path: string, endpoint: Endpoint, kind: "file" | "dir") => Promise<boolean>,
): Promise<void> {
  const step = async (current: string): Promise<boolean> => {
    signal.throwIfAborted();
    const endpoint = filesystem(current, ports);
    const kind = await endpoint.kind();
    if (kind !== "file" && kind !== "dir")
      throw new ToolRefused("walk", "expected a regular file or directory");
    if (!(await visit(current, endpoint, kind))) return false;
    if (kind === "file") return true;
    for (const entry of await endpoint.list()) {
      if (entry.kind !== "file" && entry.kind !== "dir") continue;
      if (!(await step(childPath(endpoint.locus, entry.name)))) return false;
    }
    return true;
  };
  await step(path);
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
