import { describe, expect, it } from "bun:test";
import type { Machine } from "@openomni/protocol";
import {
  MachineVfsError,
  type MachineFsPort,
  createMachineVfs,
  parseVfsPath,
} from "../src/machines/vfs";

/** A port that records what the router asked and answers with a fixed outcome. */
function recordingPort(outcome: Awaited<ReturnType<MachineFsPort>>) {
  const calls: { machineId: string; request: Machine.FsRequest }[] = [];
  const port: MachineFsPort = async (machineId, request) => {
    calls.push({ machineId, request });
    return outcome;
  };
  return { calls, port };
}

describe("parseVfsPath", () => {
  it("splits the flat namespace into machine, export, and the path inside it", () => {
    expect(parseVfsPath("/machines/alpha/notes/plans/q3.md")).toEqual({
      machineId: "alpha",
      export: "notes",
      relPath: "plans/q3.md",
    });
  });

  it("reads an export with no trailing path as the export root", () => {
    expect(parseVfsPath("/machines/alpha/notes")).toEqual({
      machineId: "alpha",
      export: "notes",
      relPath: "",
    });
    expect(parseVfsPath("/machines/alpha/notes/")).toEqual({
      machineId: "alpha",
      export: "notes",
      relPath: "",
    });
  });

  it("refuses a path that is not under /machines", () => {
    expect(() => parseVfsPath("/etc/passwd")).toThrow(
      'path must start with /machines/<machineId>/<export>: "/etc/passwd"',
    );
    expect(() => parseVfsPath("machines/alpha/notes")).toThrow(
      'path must start with /machines/<machineId>/<export>: "machines/alpha/notes"',
    );
  });

  it("refuses a path that names a machine but no export", () => {
    expect(() => parseVfsPath("/machines/alpha")).toThrow(
      'path must name an export: "/machines/alpha"',
    );
    expect(() => parseVfsPath("/machines/alpha/")).toThrow(
      'path must name an export: "/machines/alpha/"',
    );
  });

  it("refuses an export name outside the grammar rather than passing it to the daemon", () => {
    expect(() => parseVfsPath("/machines/alpha/Notes/x")).toThrow(
      "export name must be lowercase alphanumeric with - or _ (e.g. notes)",
    );
  });

  it("refuses a .. segment at the parse boundary, before any port is reached", () => {
    expect(() => parseVfsPath("/machines/alpha/notes/../../etc/passwd")).toThrow(
      "path must be relative to the export root, with no .. segment or NUL",
    );
  });

  it("refuses an embedded NUL", () => {
    expect(() => parseVfsPath("/machines/alpha/notes/a\u0000b")).toThrow(
      "path must be relative to the export root, with no .. segment or NUL",
    );
  });

  it("throws MachineVfsError, so a caller can tell a refusal from a crash", () => {
    try {
      parseVfsPath("/etc/passwd");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(MachineVfsError.isInstance(error)).toBe(true);
      expect((error as InstanceType<typeof MachineVfsError>).data.reason).toBe("bad_path");
    }
  });
});

describe("the machine vfs router", () => {
  it("routes a read to the machine and export the path named", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "read", data: "hello", bytesRead: 5, size: 5, truncated: false },
    });
    const vfs = createMachineVfs(port);

    const value = await vfs.read({ path: "/machines/alpha/notes/greeting.txt" });

    expect(calls).toEqual([
      {
        machineId: "alpha",
        request: { op: "read", export: "notes", path: "greeting.txt" },
      },
    ]);
    expect(value).toEqual({
      op: "read",
      data: "hello",
      bytesRead: 5,
      size: 5,
      truncated: false,
    });
  });

  it("passes an offset/limit window through unchanged", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "read", data: "ell", bytesRead: 3, size: 5, truncated: true },
    });
    const vfs = createMachineVfs(port);

    await vfs.read({ path: "/machines/alpha/notes/greeting.txt", offset: 1, limit: 3 });

    expect(calls[0]?.request).toEqual({
      op: "read",
      export: "notes",
      path: "greeting.txt",
      offset: 1,
      limit: 3,
    });
  });

  it("routes list and stat with the same parse", async () => {
    const calls: Machine.FsRequest[] = [];
    const vfs = createMachineVfs(async (_machineId, request) => {
      calls.push(request);
      return request.op === "list"
        ? { status: "completed", value: { op: "list", entries: [], truncated: false } }
        : { status: "completed", value: { op: "stat", kind: "file", size: 0, mtimeMs: 0 } };
    });

    await vfs.list({ path: "/machines/alpha/notes" });
    await vfs.stat({ path: "/machines/alpha/notes/a.txt" });

    expect(calls).toEqual([
      { op: "list", export: "notes", path: "" },
      { op: "stat", export: "notes", path: "a.txt" },
    ]);
  });

  it("throws the daemon's refusal reason and message rather than returning it as a value", async () => {
    const { port } = recordingPort({
      status: "refused",
      reason: "path_escapes_export",
      message: "the resolved path is outside the export root",
    });
    const vfs = createMachineVfs(port);

    const failure = await vfs.read({ path: "/machines/alpha/notes/link" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(MachineVfsError.isInstance(failure)).toBe(true);
    expect((failure as InstanceType<typeof MachineVfsError>).data.reason).toBe(
      "path_escapes_export",
    );
    expect((failure as Error).message).toBe(
      "/machines/alpha/notes/link refused: the resolved path is outside the export root",
    );
  });

  it("throws when the machine is not attached", async () => {
    const { port } = recordingPort({ status: "refused", reason: "machine_not_attached" });
    const vfs = createMachineVfs(port);

    const failure = await vfs.list({ path: "/machines/ghost/notes" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(MachineVfsError.isInstance(failure)).toBe(true);
    expect((failure as InstanceType<typeof MachineVfsError>).data.reason).toBe(
      "machine_not_attached",
    );
    expect((failure as Error).message).toBe("machine ghost is not attached right now");
  });

  it("throws when the machine holds no fs.read reach", async () => {
    const { port } = recordingPort({ status: "refused", reason: "fs_not_available" });
    const vfs = createMachineVfs(port);

    const failure = await vfs.stat({ path: "/machines/alpha/notes/a.txt" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toBe("machine alpha may not be read from");
  });

  it("refuses a bad path before the port is reached at all", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "stat", kind: "file", size: 0, mtimeMs: 0 },
    });
    const vfs = createMachineVfs(port);

    await expect(vfs.stat({ path: "/machines/alpha/notes/../x" })).rejects.toThrow(
      "path must be relative to the export root, with no .. segment or NUL",
    );
    expect(calls).toEqual([]);
  });

  it("refuses an answer whose op does not match the question", async () => {
    const { port } = recordingPort({
      status: "completed",
      value: { op: "list", entries: [], truncated: false },
    });
    const vfs = createMachineVfs(port);

    const failure = await vfs.read({ path: "/machines/alpha/notes/a.txt" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(MachineVfsError.isInstance(failure)).toBe(true);
    expect((failure as Error).message).toBe("machine alpha answered a read with a list");
  });
});
