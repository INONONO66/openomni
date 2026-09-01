import { Machine, type Tool } from "@openomni/protocol";
import { z } from "zod";
import { MachineVfsError, type MachineVfs } from "../machines/vfs";

/**
 * The read-only slice of every attached machine, as the model addresses it:
 * one flat `/machines/<machineId>/<export>/<relpath>` namespace. The port is
 * the router (`machines/vfs.ts`); these three tools own only the wording of
 * the question and the shape of the answer.
 */
export type MachineFsPortForTools = MachineVfs;

export const FS_READ_TOOL_NAME = "fs_read";
export const FS_LIST_TOOL_NAME = "fs_list";
export const FS_STAT_TOOL_NAME = "fs_stat";

const PATH_DESCRIPTION =
  "A path in the machine namespace: /machines/<machineId>/<export>/<path inside it>.";

const ReadInput = z
  .object({
    path: z.string().min(1).describe(PATH_DESCRIPTION),
    offset: z.number().int().nonnegative().optional().describe("Byte to start reading at."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`How many bytes to read; capped at ${Machine.FS_READ_MAX_BYTES}.`),
  })
  .strict();

const PathInput = z.object({ path: z.string().min(1).describe(PATH_DESCRIPTION) }).strict();

const PATH_PROPERTY = { type: "string", minLength: 1, description: PATH_DESCRIPTION };

/**
 * Hand-written for the same reason run_code's is: zod 3 ships no JSON Schema
 * conversion. The zod objects above stay the runtime gate, and the tests pin
 * the two together so they cannot drift apart silently.
 */
const READ_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: PATH_PROPERTY,
    offset: { type: "integer", minimum: 0, description: "Byte to start reading at." },
    limit: {
      type: "integer",
      exclusiveMinimum: 0,
      description: `How many bytes to read; capped at ${Machine.FS_READ_MAX_BYTES}.`,
    },
  },
};

const PATH_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: { path: PATH_PROPERTY },
};

/**
 * All three are `host`-placed and carry no `requires`, and both facts are
 * deliberate.
 *
 * The tool runs on the BRAIN — it is the host that holds the attachment and
 * forwards the request — so `machine` placement would be a lie about where
 * the code executes, and would also fold the surface out of a cell's catalog,
 * which is precisely where reading a machine's files is most useful.
 *
 * `requires: ["fs.read"]` is likewise wrong HERE, though the capability is
 * real: placement resolves `requires` against ONE target's effective set, and
 * a host-placed tool resolves against the host, which holds no machine
 * capabilities at all — declaring it would make the tool permanently
 * unofferable. The capability is per-MACHINE and the machine is named inside
 * the path, which placement cannot see; the host's `fsOp` therefore owns that
 * gate and answers `fs_not_available` for a machine without the grant.
 */
export function fsReadToolSpec(): Tool.Spec {
  return {
    name: FS_READ_TOOL_NAME,
    description:
      "Read a file on an attached machine through the flat /machines/<machineId>/<export>/<path> namespace. Use fs_list to discover what an export holds. Large files come back truncated, and say so.",
    inputSchema: READ_INPUT_JSON_SCHEMA,
    safe: true,
    placement: "host",
  };
}

export function fsListToolSpec(): Tool.Spec {
  return {
    name: FS_LIST_TOOL_NAME,
    description:
      "List a directory on an attached machine: /machines/<machineId>/<export> is the export root. Each line is kind, name, and size for files.",
    inputSchema: PATH_INPUT_JSON_SCHEMA,
    safe: true,
    placement: "host",
  };
}

export function fsStatToolSpec(): Tool.Spec {
  return {
    name: FS_STAT_TOOL_NAME,
    description:
      "What a path on an attached machine IS — file, directory, symlink, or other — with its size and last modification time.",
    inputSchema: PATH_INPUT_JSON_SCHEMA,
    safe: true,
    placement: "host",
  };
}

/** `symlink` reads as `link` so every kind fits the same narrow column. */
function kindLabel(kind: "file" | "dir" | "symlink" | "other"): string {
  switch (kind) {
    case "file":
      return "file";
    case "dir":
      return "dir";
    case "symlink":
      return "link";
    case "other":
      return "other";
  }
}

/**
 * A malformed CALL is refused as a thrown failure, like every other outcome
 * these tools produce: a cell that misspells an argument must see an
 * exception, not a string that reads like file content.
 */
function parse<T>(name: string, schema: z.ZodType<T>, rawInput: unknown): T {
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    throw new MachineVfsError({
      reason: "bad_path",
      message: `${name} refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
    });
  }
  return parsed.data;
}

export function fsReadToolExecutor(vfs: MachineVfs) {
  return async (rawInput: unknown): Promise<string> => {
    const input = parse(FS_READ_TOOL_NAME, ReadInput, rawInput);
    const value = await vfs.read(input);
    return value.truncated
      ? `${value.data}\n[truncated: ${value.bytesRead} of ${value.size} bytes]`
      : value.data;
  };
}

export function fsListToolExecutor(vfs: MachineVfs) {
  return async (rawInput: unknown): Promise<string> => {
    const input = parse(FS_LIST_TOOL_NAME, PathInput, rawInput);
    const value = await vfs.list(input);
    if (value.entries.length === 0 && !value.truncated) return `${input.path} is empty`;
    const lines = value.entries.map((entry) => {
      const kind = kindLabel(entry.kind).padEnd(5);
      return entry.size === undefined
        ? `${kind} ${entry.name}`
        : `${kind} ${entry.name}  ${entry.size} bytes`;
    });
    if (value.truncated) {
      lines.push(`[truncated at ${value.entries.length} entries]`);
    }
    return lines.join("\n");
  };
}

export function fsStatToolExecutor(vfs: MachineVfs) {
  return async (rawInput: unknown): Promise<string> => {
    const input = parse(FS_STAT_TOOL_NAME, PathInput, rawInput);
    const value = await vfs.stat(input);
    return `${kindLabel(value.kind).padEnd(5)} ${value.size} bytes  modified ${new Date(value.mtimeMs).toISOString()}`;
  };
}
