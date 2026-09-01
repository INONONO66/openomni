import type { FsOpOutcome } from "@openomni/machines";
import { Machine, NamedError } from "@openomni/protocol";
import { z } from "zod";

/**
 * Why a machine-fs call did not produce a value. Two of these are the app's
 * own reading of the attachment table (`machine_not_attached`, `fs_not_available`
 * — the host's refusal arms), one is the router's parse (`bad_path`), one is a
 * peer that answered a question it was not asked (`wrong_answer`), and the rest
 * are the daemon's own typed refusals passed through unflattened, so the model
 * learns WHICH boundary held.
 */
const MachineVfsErrorData = z.object({
  reason: z.union([
    z.literal("bad_path"),
    z.literal("machine_not_attached"),
    z.literal("fs_not_available"),
    z.literal("wrong_answer"),
    Machine.FsResult.options[1].shape.reason,
  ]),
  message: z.string().min(1),
});

export const MachineVfsError = NamedError.create("MachineVfsError", MachineVfsErrorData);

/**
 * The one outcome a machine-fs call can produce, re-exported from the host
 * that owns it: the app states this contract in exactly one place, so a new
 * refusal arm on the host side is a type error here rather than a silent
 * fallthrough to "the daemon refused".
 */
export type { FsOpOutcome };

/**
 * The host's fs door as the app holds it: one machine, one request, one
 * outcome. The composition root binds `MachineHost.fsOp`; tests bind a fake.
 */
export type MachineFsPort = (
  machineId: Machine.MachineId,
  request: Machine.FsRequest,
) => Promise<FsOpOutcome>;

/** Where a `/machines/<machineId>/<export>/<relPath>` path points. */
export interface VfsLocation {
  readonly machineId: Machine.MachineId;
  readonly export: Machine.ExportName;
  /** Relative to the export root — `""` IS the root, never `"/"`. */
  readonly relPath: string;
}

const NAMESPACE_PREFIX = "/machines/";

function refuse(reason: z.infer<typeof MachineVfsErrorData>["reason"], message: string): never {
  throw new MachineVfsError({ reason, message });
}

/**
 * Reads the flat namespace into the three facts the wire needs.
 *
 * The grammar checks are the protocol's own (`Machine.ExportName`,
 * `Machine.FsRequest`'s path refinement), reached by constructing the request
 * this parse feeds — so the router cannot develop a second, laxer opinion
 * about what a legal path is. This is the cheap first gate only: the daemon
 * still owns confinement against its real export root.
 */
export function parseVfsPath(path: string): VfsLocation {
  if (!path.startsWith(NAMESPACE_PREFIX)) {
    refuse("bad_path", `path must start with /machines/<machineId>/<export>: "${path}"`);
  }
  const [machineId, exportName, ...rest] = path.slice(NAMESPACE_PREFIX.length).split("/");
  if (machineId === undefined || machineId.length === 0) {
    refuse("bad_path", `path must name a machine: "${path}"`);
  }
  if (exportName === undefined || exportName.length === 0) {
    refuse("bad_path", `path must name an export: "${path}"`);
  }
  const parsedExport = Machine.ExportName.safeParse(exportName);
  if (!parsedExport.success) {
    refuse("bad_path", parsedExport.error.issues[0]?.message ?? `bad export name: "${exportName}"`);
  }
  // A trailing slash is the export root spelled long, not an empty final
  // segment the daemon should resolve.
  const relPath = rest.join("/").replace(/\/+$/, "");
  // The path refinement is the protocol's, reached through the very request
  // shape this parse will feed, so the router cannot develop a laxer opinion.
  const parsedPath = Machine.FsRequest.safeParse({
    op: "stat",
    export: parsedExport.data,
    path: relPath,
  });
  if (!parsedPath.success) {
    refuse("bad_path", parsedPath.error.issues[0]?.message ?? `bad path: "${path}"`);
  }
  return { machineId, export: parsedExport.data, relPath };
}

/** A read window into one file; both bounds are the protocol's to validate. */
interface VfsReadArgs {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface MachineVfs {
  read(args: VfsReadArgs): Promise<Extract<Machine.FsValue, { op: "read" }>>;
  list(args: { readonly path: string }): Promise<Extract<Machine.FsValue, { op: "list" }>>;
  stat(args: { readonly path: string }): Promise<Extract<Machine.FsValue, { op: "stat" }>>;
}

function build(op: Machine.FsRequest["op"], location: VfsLocation, window: VfsReadArgs) {
  const parsed = Machine.FsRequest.safeParse({
    op,
    export: location.export,
    path: location.relPath,
    ...(window.offset === undefined ? {} : { offset: window.offset }),
    ...(window.limit === undefined ? {} : { limit: window.limit }),
  });
  if (!parsed.success) {
    refuse("bad_path", parsed.error.issues[0]?.message ?? "invalid fs request");
  }
  return parsed.data;
}

/**
 * The read-only slice of every attached machine as one flat namespace.
 *
 * Every failure LEAVES as a throw, not as a value: both doors into the catalog
 * turn a throwing tool into an error result (`dispatch.ts`), and the cell door
 * turns that into a catchable `ToolError` — so cell code that reads a missing
 * file fails loudly instead of storing the refusal text as data.
 */
export function createMachineVfs(fsOp: MachineFsPort): MachineVfs {
  async function run<Op extends Machine.FsRequest["op"]>(
    op: Op,
    args: VfsReadArgs,
  ): Promise<Extract<Machine.FsValue, { op: Op }>> {
    const location = parseVfsPath(args.path);
    const outcome = await fsOp(location.machineId, build(op, location, args));
    if (outcome.status === "refused") {
      switch (outcome.reason) {
        case "machine_not_attached":
          refuse(outcome.reason, `machine ${location.machineId} is not attached right now`);
          break;
        case "fs_not_available":
          refuse(outcome.reason, `machine ${location.machineId} may not be read from`);
          break;
        default:
          refuse(outcome.reason, `${args.path} refused: ${outcome.message}`);
      }
    }
    if (outcome.value.op !== op) {
      refuse(
        "wrong_answer",
        `machine ${location.machineId} answered a ${op} with a ${outcome.value.op}`,
      );
    }
    return outcome.value as Extract<Machine.FsValue, { op: Op }>;
  }

  return {
    read: (args) => run("read", args),
    list: (args) => run("list", args),
    stat: (args) => run("stat", args),
  };
}
