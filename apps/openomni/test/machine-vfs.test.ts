import { describe, expect, it } from "bun:test";
import type { Machine } from "@openomni/protocol";
import {
  MachineVfsError,
  type MachineFsPort,
  createMachineVfs,
  parseVfsPath,
  scopeMachineVfs,
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

type Reason = InstanceType<typeof MachineVfsError>["data"]["reason"];

/**
 * The exact typed signal, never a substring: the class the caller can catch,
 * the reason it can branch on, and the whole sentence the model reads. A
 * `toThrow("...")` matcher passes on a message that merely CONTAINS the text,
 * so a refusal that silently grew a leading path or a different reason would
 * still be green.
 */
function expectRefusal(thrown: unknown, reason: Reason, message: string): void {
  expect(MachineVfsError.isInstance(thrown)).toBe(true);
  const error = thrown as InstanceType<typeof MachineVfsError>;
  expect(error.data.reason).toBe(reason);
  expect(error.data.message).toBe(message);
  expect(error.message).toBe(message);
}

/** Runs `act`, returning what it threw — failing loudly if it threw nothing. */
function thrownBy(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, got a value");
}

/** The async spelling of {@link thrownBy}. */
async function rejectedBy(act: () => Promise<unknown>): Promise<unknown> {
  return await act().then(
    () => {
      throw new Error("expected a refusal, got a value");
    },
    (error: unknown) => error,
  );
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
    expectRefusal(
      thrownBy(() => parseVfsPath("/etc/passwd")),
      "bad_path",
      'path must start with /machines/<machineId>/<export>: "/etc/passwd"',
    );
    expectRefusal(
      thrownBy(() => parseVfsPath("machines/alpha/notes")),
      "bad_path",
      'path must start with /machines/<machineId>/<export>: "machines/alpha/notes"',
    );
  });

  it("refuses a path that names a machine but no export", () => {
    expectRefusal(
      thrownBy(() => parseVfsPath("/machines/alpha")),
      "bad_path",
      'path must name an export: "/machines/alpha"',
    );
    expectRefusal(
      thrownBy(() => parseVfsPath("/machines/alpha/")),
      "bad_path",
      'path must name an export: "/machines/alpha/"',
    );
  });

  it("refuses an export name outside the grammar rather than passing it to the daemon", () => {
    expectRefusal(
      thrownBy(() => parseVfsPath("/machines/alpha/Notes/x")),
      "bad_path",
      "export name must be lowercase alphanumeric with - or _ (e.g. notes)",
    );
  });

  it("refuses a .. segment at the parse boundary, before any port is reached", () => {
    expectRefusal(
      thrownBy(() => parseVfsPath("/machines/alpha/notes/../../etc/passwd")),
      "bad_path",
      "path must be relative to the export root, with no .. segment or NUL",
    );
  });

  it("refuses an embedded NUL", () => {
    expectRefusal(
      thrownBy(() => parseVfsPath("/machines/alpha/notes/a\u0000b")),
      "bad_path",
      "path must be relative to the export root, with no .. segment or NUL",
    );
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

    const failure = await rejectedBy(() => vfs.read({ path: "/machines/alpha/notes/link" }));

    expectRefusal(
      failure,
      "path_escapes_export",
      "/machines/alpha/notes/link refused: the resolved path is outside the export root",
    );
  });

  it("throws when the machine is not attached", async () => {
    const { port } = recordingPort({ status: "refused", reason: "machine_not_attached" });
    const vfs = createMachineVfs(port);

    const failure = await rejectedBy(() => vfs.list({ path: "/machines/ghost/notes" }));

    expectRefusal(failure, "machine_not_attached", "machine ghost is not attached right now");
  });

  it("throws when the machine holds no fs.read reach", async () => {
    const { port } = recordingPort({ status: "refused", reason: "fs_not_available" });
    const vfs = createMachineVfs(port);

    const failure = await rejectedBy(() => vfs.stat({ path: "/machines/alpha/notes/a.txt" }));

    expectRefusal(failure, "fs_not_available", "machine alpha may not be read from");
  });

  it("refuses a bad path before the port is reached at all", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "stat", kind: "file", size: 0, mtimeMs: 0 },
    });
    const vfs = createMachineVfs(port);

    const failure = await rejectedBy(() => vfs.stat({ path: "/machines/alpha/notes/../x" }));

    expectRefusal(
      failure,
      "bad_path",
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

    const failure = await rejectedBy(() => vfs.read({ path: "/machines/alpha/notes/a.txt" }));

    expectRefusal(failure, "wrong_answer", "machine alpha answered a read with a list");
  });
});

/**
 * A cell's authority is the machine it runs on. The composition root binds
 * that machine into the cell's catalog (`index.ts`, `toolsFor(origin,
 * machineId)`); these pin the narrowing itself.
 */
describe("the cell-scoped vfs", () => {
  it("refuses every op that names another machine, before the port is reached", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "read", data: "secret", bytesRead: 6, size: 6, truncated: false },
    });
    const scoped = scopeMachineVfs(createMachineVfs(port), "alpha");

    expectRefusal(
      await rejectedBy(() => scoped.read({ path: "/machines/beta/docs/secret.txt" })),
      "cross_machine_denied",
      "/machines/beta/docs/secret.txt is not reachable from a cell on machine alpha",
    );
    expectRefusal(
      await rejectedBy(() => scoped.list({ path: "/machines/beta/docs" })),
      "cross_machine_denied",
      "/machines/beta/docs is not reachable from a cell on machine alpha",
    );
    expectRefusal(
      await rejectedBy(() => scoped.stat({ path: "/machines/beta/docs/secret.txt" })),
      "cross_machine_denied",
      "/machines/beta/docs/secret.txt is not reachable from a cell on machine alpha",
    );
    // Nothing was asked of the host: the question was not the cell's to ask.
    expect(calls).toEqual([]);
  });

  it("passes the executing machine's own paths through untouched", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "read", data: "hello", bytesRead: 5, size: 5, truncated: false },
    });
    const scoped = scopeMachineVfs(createMachineVfs(port), "alpha");

    const value = await scoped.read({ path: "/machines/alpha/notes/greeting.txt", limit: 5 });

    expect(value.data).toBe("hello");
    expect(calls).toEqual([
      {
        machineId: "alpha",
        request: { op: "read", export: "notes", path: "greeting.txt", limit: 5 },
      },
    ]);
  });

  it("refuses a malformed path as bad_path, not as a crossing", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "stat", kind: "file", size: 0, mtimeMs: 0 },
    });
    const scoped = scopeMachineVfs(createMachineVfs(port), "alpha");

    expectRefusal(
      await rejectedBy(() => scoped.stat({ path: "/etc/passwd" })),
      "bad_path",
      'path must start with /machines/<machineId>/<export>: "/etc/passwd"',
    );
    expect(calls).toEqual([]);
  });

  it("is not fooled by a machine id that merely prefixes the executing one", async () => {
    const { calls, port } = recordingPort({
      status: "completed",
      value: { op: "list", entries: [], truncated: false },
    });
    const scoped = scopeMachineVfs(createMachineVfs(port), "alpha");

    expectRefusal(
      await rejectedBy(() => scoped.list({ path: "/machines/alpha-evil/notes" })),
      "cross_machine_denied",
      "/machines/alpha-evil/notes is not reachable from a cell on machine alpha",
    );
    expect(calls).toEqual([]);
  });
});
