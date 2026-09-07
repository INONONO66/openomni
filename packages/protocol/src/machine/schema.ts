import { z } from "zod";
import { EpochMs } from "../time.js";
import { PlainValueSchema } from "../json.js";

/**
 * Capability id grammar: two-plus dot-separated lowercase segments —
 * `fs.read`, `shell.exec`, `kernel.py`, `screen.read`, `input.write`.
 * The vocabulary is open (drivers introduce ids as they earn them); the
 * GRAMMAR is owned here so the enrollment writer, the daemon's offer, and
 * the tool catalog's `requires` can never drift into three spellings.
 */
export const CapabilityId = z
  .string()
  .max(128, { message: "capability id must be at most 128 characters" })
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, {
    message: "capability id must be dot-namespaced lowercase (e.g. fs.read)",
  });
export type CapabilityId = z.infer<typeof CapabilityId>;

/** Capability ids whose behavior is defined by the machine protocol. */
export const WellKnownCapability = {
  pythonKernel: "kernel.py",
  /**
   * ONE capability gates the whole read-only fs surface (read|list|stat).
   * Splitting it per-op would let an Owner grant `list` while believing they
   * withheld `read`, when a listing already leaks the names it enumerates.
   */
  fsRead: "fs.read",
  fsWrite: "fs.write",
  shellExec: "shell.exec",
} as const satisfies Record<string, CapabilityId>;

/**
 * Export name grammar: a daemon-local confinement root identifier.
 * Flat and lowercase so a name can never be confused with a path (no dot, no
 * slash, no leading dash that an argv parser would eat) and so the Owner's
 * enrollment spelling matches the daemon's offer byte for byte.
 */
export const ExportName = z
  .string()
  .max(64, { message: "export name must be at most 64 characters" })
  .regex(/^[a-z][a-z0-9_-]*$/, {
    message: "export name must be lowercase alphanumeric with - or _ (e.g. notes)",
  });
export type ExportName = z.infer<typeof ExportName>;

export const AbsolutePath = z
  .string()
  .refine(
    (path) => path.startsWith("/") && !path.includes("\0") && !path.split("/").includes(".."),
    { message: "expected an absolute path without NUL or .. segments" },
  );

export const MachineId = z.string().min(1);
export type MachineId = z.infer<typeof MachineId>;

/** One owner for the frozen machine wire method names used by both peers. */
export const WireMethod = {
  Attach: "machine.attach",
  RunCode: "machine.run_code",
  CancelCode: "machine.cancel_code",
  Exec: "machine.exec",
  CallTool: "machine.call_tool",
  FsOp: "machine.fs_op",
} as const;

/** Shared by Enrollment/Offer arrays and the machine.attached event payload. */
export function uniqueCapabilities(capabilities: string[], ctx: z.RefinementCtx): void {
  if (new Set(capabilities).size !== capabilities.length) {
    ctx.addIssue({ code: "custom", message: "capabilities must be unique" });
  }
}

/** Shared by the enrollment allowlist, the offer, and the attach result. */
function uniqueExports(names: string[], ctx: z.RefinementCtx): void {
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: "custom", message: "export names must be unique" });
  }
}

/**
 * Owner-side admission record: what this machine is ALLOWED to do.
 * One half of the effective-capability fold (`fold.ts`) — the other half is
 * the daemon's `Offer`. An enrollment with no capability is a contradiction
 * (there would be nothing to attach for), hence `.min(1)`.
 */
export const Enrollment = z
  .object({
    machineId: MachineId,
    name: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    allowedCapabilities: z.array(CapabilityId).min(1).superRefine(uniqueCapabilities),
    /**
     * Which exports the fs surface may reach. Absence grants no exports.
     */
    allowedExports: z.array(ExportName).superRefine(uniqueExports).optional(),
    enrolledAt: EpochMs,
  })
  .strict();
export type Enrollment = z.infer<typeof Enrollment>;

/**
 * Daemon-side attach report: what this machine CAN do right now.
 * May be empty — a daemon is allowed to attach before any capability module
 * is ready; it simply yields an empty effective set until it re-offers.
 */
export const Offer = z
  .object({
    machineId: MachineId,
    offeredCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
    /**
     * Real absolute roots used to translate consumer paths into confined wire
     * requests. Longest matching root wins; equal roots are ambiguous.
     */
    exports: z
      .array(z.object({ name: ExportName, path: AbsolutePath }).strict())
      .superRefine((entries, ctx) => {
        uniqueExports(
          entries.map((entry) => entry.name),
          ctx,
        );
      })
      .optional(),
    daemonVersion: z.string().min(1),
    /** e.g. "darwin-arm64" — display/diagnostic fact, never a matching key. */
    platform: z.string().min(1),
    offeredAt: EpochMs,
  })
  .strict();
export type Offer = z.infer<typeof Offer>;

/**
 * Host reply to a daemon's `machine.attach` wire call. `refused` is a typed
 * outcome, not a transport error: the connection stays open and the daemon
 * may re-offer after the Owner fixes the enrollment.
 */
export const AttachResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("attached"),
      effectiveCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
      effectiveExports: z.array(ExportName).superRefine(uniqueExports),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_enrolled", "machine_mismatch"]),
    })
    .strict(),
]);
export type AttachResult = z.infer<typeof AttachResult>;

export const CellRequest = z
  .object({
    cellId: z.string().min(1),
    code: z.string(),
    timeoutMs: z.number().int().positive(),
    /**
     * Which tenant's interpreter runs the cell. One attachment can serve
     * several sessions, and a Python interpreter offers no in-process
     * isolation — state, and any thread a cell leaves behind, are reachable
     * by whatever runs in that process next. The daemon therefore keeps one
     * interpreter per tenant so a cell can only ever share a process with
     * cells of the same session. Absent on the wire reads as "default".
     */
    tenant: z.string().min(1).optional(),
  })
  .strict();
export type CellRequest = z.infer<typeof CellRequest>;

const CellOutput = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

/**
 * A `tool.<name>(...)` call made from inside a running cell, travelling back to
 * the host over the same attachment (docs/machines-and-delegation.md §5.5).
 * This is what makes a cell worth more than N tool round trips.
 */
export const ToolCall = z
  .object({
    cellId: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), PlainValueSchema),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCall>;

/**
 * Two arms because the cell can only do two things with the answer: use the
 * value, or see an exception. A refused tool is a `failed` whose message says
 * so — the host's tool port owns that judgment, not this contract.
 */
export const ToolCallResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), value: PlainValueSchema.optional() }).strict(),
  z.object({ status: z.literal("failed"), error: z.string().min(1) }).strict(),
]);
export type ToolCallResult = z.infer<typeof ToolCallResult>;

/** Honest Python cell terminals: deadline expiry is never collapsed into a raise. */
export const CellResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      cellId: z.string().min(1),
      output: CellOutput,
      value: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("raised"),
      cellId: z.string().min(1),
      output: CellOutput,
      error: z.string(),
    })
    .strict(),
  z.object({ status: z.literal("timed_out"), cellId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("cancelled"), cellId: z.string().min(1) }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_attached", "kernel_not_available"]),
    })
    .strict(),
]);
export type CellResult = z.infer<typeof CellResult>;

/**
 * Ceilings for one fs op, owned here so host, daemon, and tool surface quote
 * the same number. The daemon ENFORCES them (it is the only side holding the
 * bytes); the contract only names them and reports `truncated` when they bite.
 */
export const FS_READ_MAX_BYTES = 262_144;
export const FS_WRITE_MAX_BYTES = 262_144;
export const EXEC_MAX_BYTES = 262_144;
export const EXEC_TIMEOUT_MS = 30_000;
const Base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const FS_LIST_MAX_ENTRIES = 1000;

/**
 * A path INSIDE an export: `""` is the export root, otherwise slash-separated
 * relative segments. The schema refuses the three shapes that turn a relative
 * path into an escape — a leading `/` (re-anchors at the real filesystem root),
 * any `..` segment (climbs out before any realpath check runs), and an embedded
 * NUL (truncates the path in a C syscall past whatever we validated). This is a
 * cheap first gate, not the confinement boundary: the daemon still resolves and
 * re-checks containment against its own export root.
 */
const FsPath = z
  .string()
  .refine(
    (value) =>
      !(value.startsWith("/") || value.includes("\u0000")) &&
      !value.split("/").some((segment) => segment === ".."),
    { message: "path must be relative to the export root, with no .. segment or NUL" },
  );

/** Export-relative requests; the daemon owns the final confinement check. */
export const FsRequest = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("read"),
      export: ExportName,
      path: FsPath,
      /** Byte window into the file; absent reads from the start, up to the cap. */
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ op: z.literal("write"), export: ExportName, path: FsPath, data: Base64 }).strict(),
  z.object({ op: z.literal("list"), export: ExportName, path: FsPath }).strict(),
  z.object({ op: z.literal("stat"), export: ExportName, path: FsPath }).strict(),
]);
export type FsRequest = z.infer<typeof FsRequest>;

/**
 * What a path IS, coarsely. `symlink` stays visible rather than being resolved
 * away, because a link is exactly the entry whose target may sit outside the
 * export; `other` covers sockets/devices the read surface will not open.
 */
const FsEntryKind = z.enum(["file", "dir", "symlink", "other"]);

/** Answer shapes keyed by the op that asked, so a reply can never be mismatched. */
const FsValue = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), bytesWritten: z.number().int().nonnegative() }).strict(),
  z
    .object({
      op: z.literal("read"),
      /**
       * Lossless base64 bytes on JSON wire; consumer handles decode to bytes.
       */
      data: Base64,
      bytesRead: z.number().int().nonnegative(),
      /** Full file size, so a truncated read still reports what it missed. */
      size: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("list"),
      entries: z.array(
        z
          .object({
            name: z.string().min(1),
            kind: FsEntryKind,
            size: z.number().int().nonnegative().optional(),
          })
          .strict(),
      ),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("stat"),
      kind: FsEntryKind,
      size: z.number().int().nonnegative(),
      mtimeMs: z.number(),
    })
    .strict(),
]);
export type FsValue = z.infer<typeof FsValue>;

/**
 * `refused` is a typed outcome, not a transport error: the attachment survives
 * and the model learns WHY. The reasons stay coarse on purpose —
 * `path_escapes_export` and `export_not_available` say a boundary held, without
 * disclosing whether the target exists behind it.
 */
export const FsResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), value: FsValue }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "export_not_available",
        "path_escapes_export",
        "not_found",
        "wrong_kind",
        "io_error",
        "too_large",
        "ambiguous_export",
        "machine_not_attached",
        "fs_not_available",
      ]),
      message: z.string().min(1),
    })
    .strict(),
]);
export type FsResult = z.infer<typeof FsResult>;

export const ExecRequest = z.object({ cmd: z.string().min(1), cwd: AbsolutePath }).strict();
export type ExecRequest = z.infer<typeof ExecRequest>;
export const ExecResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      stdout: Base64,
      stderr: Base64,
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "exec_not_available",
        "path_escapes_export",
        "io_error",
      ]),
    })
    .strict(),
  z.object({ status: z.enum(["timed_out", "cancelled"]) }).strict(),
]);
export type ExecResult = z.infer<typeof ExecResult>;
export const CancelCode = z.object({ cellId: z.string().min(1) }).strict();
export const CancelResult = z.object({ cancelled: z.boolean() }).strict();
