import { Machine } from "@openomni/protocol";
import { z } from "zod";
import { MachineVfsError, type MachineVfs } from "../../machines/vfs";
import { defineTool, ToolRefused } from "../core/define";

export const FS_READ_TOOL_NAME = "fs_read";
export const FS_LIST_TOOL_NAME = "fs_list";
export const FS_STAT_TOOL_NAME = "fs_stat";
const PATH_DESCRIPTION = "A path in the machine namespace: /machines/<machineId>/<export>/<path inside it>.";
const ReadInput = z.object({
  path: z.string().min(1).describe(PATH_DESCRIPTION),
  offset: z.number().int().nonnegative().optional().describe("Byte to start reading at."),
  limit: z.number().int().positive().optional().describe(`How many bytes to read; capped at ${Machine.FS_READ_MAX_BYTES}.`),
}).strict();
const PathInput = z.object({ path: z.string().min(1).describe(PATH_DESCRIPTION) }).strict();
const READ_WIRE_PROJECTION = {
  type: "object", additionalProperties: false, required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, description: PATH_DESCRIPTION },
    offset: { type: "integer", minimum: 0, description: "Byte to start reading at." },
    limit: { type: "integer", exclusiveMinimum: 0, description: `How many bytes to read; capped at ${Machine.FS_READ_MAX_BYTES}.` },
  },
} as const;
const PATH_WIRE_PROJECTION = {
  type: "object", additionalProperties: false, required: ["path"],
  properties: { path: { type: "string", minLength: 1, description: PATH_DESCRIPTION } },
} as const;
const ReadOutput = z.custom<Awaited<ReturnType<MachineVfs["read"]>>>((value) => typeof value === "object" && value !== null);
const ListOutput = z.custom<Awaited<ReturnType<MachineVfs["list"]>>>((value) => typeof value === "object" && value !== null);
const StatOutput = z.custom<Awaited<ReturnType<MachineVfs["stat"]>>>((value) => typeof value === "object" && value !== null);
function refused(name: string, error: unknown): never {
  throw new ToolRefused(name, error instanceof MachineVfsError ? error.data.message : error instanceof Error ? error.message : String(error));
}
function fsReadToolExecutor(vfs: MachineVfs) { return async (input: z.output<typeof ReadInput>) => { try { return await vfs.read(input); } catch (error) { return refused(FS_READ_TOOL_NAME, error); } }; }
function fsListToolExecutor(vfs: MachineVfs) { return async (input: z.output<typeof PathInput>) => { try { return await vfs.list(input); } catch (error) { return refused(FS_LIST_TOOL_NAME, error); } }; }
function fsStatToolExecutor(vfs: MachineVfs) { return async (input: z.output<typeof PathInput>) => { try { return await vfs.stat(input); } catch (error) { return refused(FS_STAT_TOOL_NAME, error); } }; }
function kindLabel(kind: "file" | "dir" | "symlink" | "other"): string { return kind === "symlink" ? "link" : kind; }
const common = { safe: true, execution: { kind: "machine", capability: "fs.read" } as const, placement: "host" as const, visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] } as const };
export const fsReadTool = defineTool({
  ...common, name: FS_READ_TOOL_NAME, category: "query",
  description: "Read a file on an attached machine through the flat /machines/<machineId>/<export>/<path> namespace. Use fs_list to discover what an export holds. Large files come back truncated, and say so.",
  input: ReadInput, output: ReadOutput, wireProjection: READ_WIRE_PROJECTION,
  bind: (ports) => ports.machineFs === undefined ? undefined : fsReadToolExecutor(ports.machineFs),
  render: (_args, value) => value.truncated ? `${value.data}\n[truncated: ${value.bytesRead} of ${value.size} bytes]` : value.data,
});
export const fsListTool = defineTool({
  ...common, name: FS_LIST_TOOL_NAME, category: "query",
  description: "List a directory on an attached machine: /machines/<machineId>/<export> is the export root. Each line is kind, name, and size for files.",
  input: PathInput, output: ListOutput, wireProjection: PATH_WIRE_PROJECTION,
  bind: (ports) => ports.machineFs === undefined ? undefined : fsListToolExecutor(ports.machineFs),
  render: (input, value) => {
    if (value.entries.length === 0 && !value.truncated) return `${input.path} is empty`;
    const lines = value.entries.map((entry) => `${kindLabel(entry.kind).padEnd(5)} ${entry.name}${entry.size === undefined ? "" : `  ${entry.size} bytes`}`);
    if (value.truncated) lines.push(`[truncated at ${value.entries.length} entries]`);
    return lines.join("\n");
  },
});
export const fsStatTool = defineTool({
  ...common, name: FS_STAT_TOOL_NAME, category: "query",
  description: "What a path on an attached machine IS — file, directory, symlink, or other — with its size and last modification time.",
  input: PathInput, output: StatOutput, wireProjection: PATH_WIRE_PROJECTION,
  bind: (ports) => ports.machineFs === undefined ? undefined : fsStatToolExecutor(ports.machineFs),
  render: (_args, value) => `${kindLabel(value.kind).padEnd(5)} ${value.size} bytes  modified ${new Date(value.mtimeMs).toISOString()}`,
});
