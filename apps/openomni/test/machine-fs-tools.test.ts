import { describe, expect, it } from "bun:test";
import { Placement } from "@openomni/placement";
import type { Machine } from "@openomni/protocol";
import type { DelegationOrigin } from "../src/delegation/admission";
import type { FsOpOutcome, MachineFsPort } from "../src/machines/vfs";
import { createMachineVfs } from "../src/machines/vfs";
import { catalogEntries } from "../src/tools/core/catalog";
import { createDispatcher, HOST_TARGET } from "../src/tools/core/dispatch";
import {
  FS_LIST_TOOL_NAME,
  FS_READ_TOOL_NAME,
  FS_STAT_TOOL_NAME,
  fsListToolSpec,
  fsReadToolSpec,
  fsStatToolSpec,
} from "../src/tools/machine-fs";

const RESIDENT: DelegationOrigin = { role: "resident", depth: 0, sessionId: "fs-tools" };

/** A machine whose one export answers with fixed content, refusing anything else. */
function fakeMachine(answers: Record<string, FsOpOutcome>): MachineFsPort {
  return async (machineId, request) => {
    const key = `${machineId}:${request.op}:${request.export}:${request.path}`;
    return (
      answers[key] ?? {
        status: "refused",
        reason: "not_found",
        message: `nothing at ${request.path}`,
      }
    );
  };
}

function fsCatalog(port: MachineFsPort) {
  return createDispatcher(catalogEntries({ machineFs: createMachineVfs(port) }, RESIDENT));
}

describe("the machine fs tools in the catalog", () => {
  it("is absent from the catalog when no machine fs port is wired", () => {
    const names = catalogEntries({}, RESIDENT).map((entry) => entry.spec.name);
    expect(names).not.toContain(FS_READ_TOOL_NAME);
    expect(names).not.toContain(FS_LIST_TOOL_NAME);
    expect(names).not.toContain(FS_STAT_TOOL_NAME);
  });

  it("appears when the port is wired", () => {
    const names = catalogEntries({ machineFs: createMachineVfs(fakeMachine({})) }, RESIDENT).map(
      (entry) => entry.spec.name,
    );
    expect(names).toContain(FS_READ_TOOL_NAME);
    expect(names).toContain(FS_LIST_TOOL_NAME);
    expect(names).toContain(FS_STAT_TOOL_NAME);
  });

  it("is host-placed, so the brain offers it and a cell can still reach it", () => {
    const specs = [fsReadToolSpec(), fsListToolSpec(), fsStatToolSpec()];
    for (const spec of specs) {
      expect(spec.placement).toBe("host");
      expect(spec.safe).toBe(true);
    }
    const offerable = Placement.resolveTools(specs, [HOST_TARGET])
      .filter((decision) => decision.offerable)
      .map((decision) => decision.tool.name);
    expect(offerable).toEqual([FS_READ_TOOL_NAME, FS_LIST_TOOL_NAME, FS_STAT_TOOL_NAME]);
  });

  it("stays inside the lint's public-field ceiling", () => {
    for (const spec of [fsReadToolSpec(), fsListToolSpec(), fsStatToolSpec()]) {
      const schema = spec.inputSchema as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties).length).toBeLessThanOrEqual(5);
    }
  });

  it("reads a file through the flat namespace", async () => {
    const catalog = fsCatalog(
      fakeMachine({
        "alpha:read:notes:plans/q3.md": {
          status: "completed",
          value: { op: "read", data: "ship it", bytesRead: 7, size: 7, truncated: false },
        },
      }),
    );

    const result = await catalog.execute({
      id: "r1",
      tool: FS_READ_TOOL_NAME,
      input: { path: "/machines/alpha/notes/plans/q3.md" },
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("ship it");
  });

  it("says what a truncated read missed instead of pretending it read the file", async () => {
    const catalog = fsCatalog(
      fakeMachine({
        "alpha:read:notes:big.log": {
          status: "completed",
          value: { op: "read", data: "head", bytesRead: 4, size: 900, truncated: true },
        },
      }),
    );

    const result = await catalog.execute({
      id: "r2",
      tool: FS_READ_TOOL_NAME,
      input: { path: "/machines/alpha/notes/big.log" },
    });

    expect(result.output).toContain("head");
    expect(result.output).toContain("truncated: 4 of 900 bytes");
  });

  it("passes the byte window the caller asked for", async () => {
    const seen: Machine.FsRequest[] = [];
    const catalog = fsCatalog(async (_machineId, request) => {
      seen.push(request);
      return {
        status: "completed",
        value: { op: "read", data: "hip", bytesRead: 3, size: 7, truncated: true },
      };
    });

    await catalog.execute({
      id: "r3",
      tool: FS_READ_TOOL_NAME,
      input: { path: "/machines/alpha/notes/a.txt", offset: 1, limit: 3 },
    });

    expect(seen).toEqual([{ op: "read", export: "notes", path: "a.txt", offset: 1, limit: 3 }]);
  });

  it("lists an export root as one line per entry", async () => {
    const catalog = fsCatalog(
      fakeMachine({
        "alpha:list:notes:": {
          status: "completed",
          value: {
            op: "list",
            entries: [
              { name: "plans", kind: "dir" },
              { name: "readme.md", kind: "file", size: 12 },
              { name: "elsewhere", kind: "symlink" },
              { name: "socket", kind: "other" },
            ],
            truncated: false,
          },
        },
      }),
    );

    const result = await catalog.execute({
      id: "l1",
      tool: FS_LIST_TOOL_NAME,
      input: { path: "/machines/alpha/notes" },
    });

    expect(result.output).toBe(
      ["dir   plans", "file  readme.md  12 bytes", "link  elsewhere", "other socket"].join("\n"),
    );
  });

  it("says an empty directory is empty rather than answering nothing", async () => {
    const catalog = fsCatalog(
      fakeMachine({
        "alpha:list:notes:empty": {
          status: "completed",
          value: { op: "list", entries: [], truncated: false },
        },
      }),
    );

    const result = await catalog.execute({
      id: "l2",
      tool: FS_LIST_TOOL_NAME,
      input: { path: "/machines/alpha/notes/empty" },
    });

    expect(result.output).toBe("/machines/alpha/notes/empty is empty");
  });

  it("states a truncated listing so the caller does not read absence as completeness", async () => {
    const catalog = fsCatalog(
      fakeMachine({
        "alpha:list:notes:": {
          status: "completed",
          value: { op: "list", entries: [{ name: "a", kind: "file" }], truncated: true },
        },
      }),
    );

    const result = await catalog.execute({
      id: "l3",
      tool: FS_LIST_TOOL_NAME,
      input: { path: "/machines/alpha/notes" },
    });

    expect(result.output).toContain("truncated at 1 entries");
  });

  it("stats a path", async () => {
    const catalog = fsCatalog(
      fakeMachine({
        "alpha:stat:notes:a.txt": {
          status: "completed",
          value: { op: "stat", kind: "file", size: 42, mtimeMs: 1_700_000_000_000 },
        },
      }),
    );

    const result = await catalog.execute({
      id: "s1",
      tool: FS_STAT_TOOL_NAME,
      input: { path: "/machines/alpha/notes/a.txt" },
    });

    expect(result.output).toBe("file  42 bytes  modified 2023-11-14T22:13:20.000Z");
  });
});

describe("what the fs tools refuse", () => {
  it("surfaces a daemon refusal as an error result naming the boundary that held", async () => {
    const catalog = fsCatalog(
      fakeMachine({
        "alpha:read:notes:outside": {
          status: "refused",
          reason: "path_escapes_export",
          message: "the resolved path leaves the export root",
        },
      }),
    );

    const result = await catalog.execute({
      id: "x1",
      tool: FS_READ_TOOL_NAME,
      input: { path: "/machines/alpha/notes/outside" },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      "/machines/alpha/notes/outside refused: the resolved path leaves the export root",
    );
  });

  it("surfaces an unattached machine as an error result, not an empty answer", async () => {
    const catalog = fsCatalog(async () => ({ status: "refused", reason: "machine_not_attached" }));

    const result = await catalog.execute({
      id: "x2",
      tool: FS_LIST_TOOL_NAME,
      input: { path: "/machines/ghost/notes" },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe("machine ghost is not attached right now");
  });

  it("refuses a .. path at the schema, before any machine is contacted", async () => {
    let reached = false;
    const catalog = fsCatalog(async () => {
      reached = true;
      return { status: "refused", reason: "not_found", message: "unreachable" };
    });

    const result = await catalog.execute({
      id: "x3",
      tool: FS_READ_TOOL_NAME,
      input: { path: "/machines/alpha/notes/../../etc/passwd" },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      "path must be relative to the export root, with no .. segment or NUL",
    );
    expect(reached).toBe(false);
  });

  it("refuses a path with no machine identity", async () => {
    const catalog = fsCatalog(fakeMachine({}));
    const result = await catalog.execute({
      id: "x-machine",
      tool: FS_STAT_TOOL_NAME,
      input: { path: "/machines//notes" },
    });
    expect(result.isError).toBe(true);
  });

  it("refuses a path outside the /machines namespace", async () => {
    const catalog = fsCatalog(fakeMachine({}));

    const result = await catalog.execute({
      id: "x4",
      tool: FS_STAT_TOOL_NAME,
      input: { path: "/etc/passwd" },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      'path must start with /machines/<machineId>/<export>: "/etc/passwd"',
    );
  });

  it("refuses malformed input rather than guessing a path", async () => {
    const catalog = fsCatalog(fakeMachine({}));

    const missing = await catalog.execute({ id: "x5", tool: FS_READ_TOOL_NAME, input: {} });
    expect(missing.isError).toBe(true);
    expect(String(missing.output)).toStartWith("fs_read refused:");

    const negative = await catalog.execute({
      id: "x6",
      tool: FS_READ_TOOL_NAME,
      input: { path: "/machines/alpha/notes/a.txt", offset: -1 },
    });
    expect(negative.isError).toBe(true);
    expect(String(negative.output)).toStartWith("fs_read refused:");

    const extra = await catalog.execute({
      id: "x7",
      tool: FS_LIST_TOOL_NAME,
      input: { path: "/machines/alpha/notes", offset: 1 },
    });
    expect(extra.isError).toBe(true);
    expect(String(extra.output)).toStartWith("fs_list refused:");
  });
});
