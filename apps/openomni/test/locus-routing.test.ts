import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, ToolRefused } from "@openomni/agent";
import { attachMachineDaemon, createMachineHost, type MachineHandle } from "@openomni/machines";
import { Machine, type PlainValue } from "@openomni/protocol";
import { createTools } from "../src/tools/core/catalog";
import { parseLocus } from "../src/tools/locus";
import { socketPath } from "./helpers/socket-path";
import { executor } from "./helpers/executor";

const origin = { role: "resident", sessionId: "locus" } as const;
const context = { sessionId: "locus", turnId: "turn" };

describe("parseLocus", () => {
  for (const path of ["/tmp/a", "a/b", "./a:b", "/tmp/a:b", "../relative"]) {
    test(`local ${path}`, () => expect(parseLocus(path)).toEqual({ kind: "local", path }));
  }
  for (const [input, machine, path] of [
    ["m:/tmp/a:b", "m", "/tmp/a:b"],
    ["c:/", "c", "/"],
    ["node-1:/a", "node-1", "/a"],
  ] as const) {
    test(`remote ${input}`, () =>
      expect(parseLocus(input)).toEqual({ kind: "machine", machine, path }));
  }
  for (const path of [
    "",
    ":/a",
    "m:",
    "m:relative",
    "m://a",
    "m:/../a",
    "m:/a\0",
    "/machines/m/a",
    " /a\0",
    "a b:/x",
  ]) {
    test(`refuses ${JSON.stringify(path)}`, () =>
      expect(() => parseLocus(path)).toThrow(ToolRefused));
  }
});

async function fixture(
  remote: boolean,
  run: (api: {
    root: string;
    machine: MachineHandle;
    rawExec: MachineHandle["exec"];
    endpointCalls: () => { get: number; exec: number };
    path: (name: string) => string;
    cell: (
      tool: string,
      input: Record<string, PlainValue>,
    ) => ReturnType<ReturnType<typeof createDispatcher>["executeCell"]>;
    model: (
      tool: string,
      input: Record<string, PlainValue>,
    ) => ReturnType<ReturnType<typeof createDispatcher>["execute"]>;
  }) => Promise<void>,
  capabilities = ["fs.read", "fs.write", "shell.exec"],
) {
  const root = await mkdtemp(join(tmpdir(), "locus-"));
  const socket = socketPath();
  const host = await createMachineHost({
    socketPath: socket,
    enrollment: () => ({
      machineId: "c",
      name: "test",
      allowedCapabilities: capabilities,
      allowedExports: ["data", "shell"],
      enrolledAt: 1,
    }),
    events: { publish: () => undefined },
    now: () => 1,
  });
  const daemon = await attachMachineDaemon({
    socketPath: socket,
    offer: {
      machineId: "c",
      daemonVersion: "test",
      platform: "darwin-arm64",
      offeredAt: 1,
      offeredCapabilities: ["fs.read", "fs.write", "shell.exec"],
      exports: [
        { name: "data", path: root },
        { name: "shell", path: "/" },
      ],
    },
    fsExports: new Map([
      ["data", root],
      ["shell", "/"],
    ]),
  });
  const handle = host.get("c");
  const spies = {
    get: spyOn(host, "get"),
    read: spyOn(handle.fs, "read"),
    write: spyOn(handle.fs, "write"),
    list: spyOn(handle.fs, "list"),
    stat: spyOn(handle.fs, "stat"),
    exec: spyOn(handle, "exec"),
  };
  const operations: Record<string, (keyof typeof spies)[]> = {
    read: ["read"],
    write: ["write"],
    edit: ["read", "write"],
    ls: ["list"],
    find: ["stat", "list"],
    grep: ["stat", "read"],
    bash: ["exec"],
  };
  async function observe<T extends { isError?: boolean }>(
    tool: string,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const before = Object.fromEntries(
      Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]),
    );
    const result = await invoke();
    if (!result.isError) {
      for (const name of operations[tool] ?? []) {
        const count = spies[name].mock.calls.length - (before[name] ?? 0);
        if (remote) expect(count).toBeGreaterThan(0);
        else expect(count).toBe(0);
      }
    }
    return result;
  }
  try {
    const dispatcher = createDispatcher(createTools({ machines: host }, origin), { executor });
    let call = 0;
    await run({
      root,
      machine: handle,
      rawExec: handle.exec,
      endpointCalls: () => ({
        get: spies.get.mock.calls.length,
        exec: spies.exec.mock.calls.length,
      }),
      path: (name) => `${remote ? "c:" : ""}${join(root, name)}`,
      cell: (tool, input) =>
        observe(tool, () => dispatcher.executeCell({ id: `cell-${++call}`, tool, input }, context)),
      model: (tool, input) =>
        observe(tool, () => dispatcher.execute({ id: `model-${++call}`, tool, input }, context)),
    });
  } finally {
    for (const spy of Object.values(spies)) spy.mockRestore();
    await daemon.close();
    host.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const remote of [false, true]) {
  describe(remote ? "real Unix daemon tools" : "local tools", () => {
    test("all five filesystem verbs preserve values and route mutations", async () => {
      await fixture(remote, async ({ root, path, cell, model }) => {
        const file = path("file");
        expect((await cell("write", { path: file, content: "alpha\nbeta\n" })).output).toEqual({
          bytesWritten: 11,
        });
        expect(await readFile(join(root, "file"), "utf8")).toBe("alpha\nbeta\n");
        expect((await cell("read", { path: file })).output).toEqual({
          content: "alpha\nbeta\n",
          bytes: 11,
        });
        expect((await model("read", { path: file })).output).toBe("alpha\nbeta\n");
        expect((await cell("read", { path: file, offset: 2, limit: 1 })).output).toEqual({
          content: "beta",
          bytes: 11,
        });
        expect(
          (await cell("edit", { path: file, edits: [{ oldText: "beta", newText: "gamma" }] }))
            .output,
        ).toEqual({ bytesWritten: 12 });
        expect(await readFile(join(root, "file"), "utf8")).toBe("alpha\ngamma\n");
        expect((await cell("ls", { path: path(".") })).output).toEqual({
          entries: [{ name: "file", kind: "file" }],
          truncated: false,
        });
        await mkdir(join(root, "nested"));
        await writeFile(join(root, "nested", "file"), "gamma in nested\n");
        await symlink(root, join(root, "loop"));
        expect((await cell("find", { path: path("."), pattern: "**/file" })).output).toEqual({
          paths: [file, path("nested/file")],
          truncated: false,
        });
        expect((await cell("find", { path: path("."), pattern: "*", limit: 1 })).output).toEqual({
          paths: [file],
          truncated: true,
        });
        const renderedFind = await model("find", { path: path("."), pattern: "*", limit: 1 });
        expect(renderedFind.output.split("\n")[0]).toBe(file);
        expect(renderedFind.output).toContain("[truncated:");
        // A walk root must itself be a regular file or directory; symlinks are never followed.
        expect(await model("find", { path: path("loop"), pattern: "*" })).toMatchObject({
          isError: true,
          errorKind: "precondition_failed",
        });
        expect((await cell("grep", { path: path("."), pattern: "gamma" })).output).toEqual({
          matches: [
            { path: file, line: 2, text: "gamma", before: [], after: [] },
            { path: path("nested/file"), line: 1, text: "gamma in nested", before: [], after: [] },
          ],
          truncated: false,
        });
        expect(
          (await cell("grep", { path: path("."), pattern: "GAMMA", ignoreCase: true, context: 1 }))
            .output,
        ).toMatchObject({
          matches: [
            { path: file, line: 2, before: ["alpha"], after: [""] },
            { path: path("nested/file"), line: 1, before: [], after: [""] },
          ],
        });
        expect(
          (await cell("grep", { path: path("."), pattern: "a.*", literal: true })).output,
        ).toEqual({ matches: [], truncated: false });
        expect((await cell("grep", { path: file, pattern: "^al", limit: 1 })).output).toEqual({
          matches: [{ path: file, line: 1, text: "alpha", before: [], after: [] }],
          truncated: false,
        });
        const malformed = await model("grep", { path: file, pattern: "(" });
        expect(malformed.errorKind).toBe("precondition_failed");
        expect(malformed.output).toContain("invalid regular expression: (");
      });
    });
    test("binary encoding, exact edit conflict, missing files, and full cell output", async () => {
      await fixture(remote, async ({ root, path, cell, model }) => {
        const binary = Buffer.from([0, 255, 128, 1]).toString("base64");
        expect(
          (await cell("write", { path: path("binary"), content: binary, encoding: "base64" }))
            .isError,
        ).toBeUndefined();
        expect((await cell("read", { path: path("binary"), encoding: "base64" })).output).toEqual({
          content: binary,
          bytes: 4,
        });
        expect(await model("read", { path: path("binary") })).toMatchObject({
          isError: true,
          errorKind: "precondition_failed",
        });
        expect(
          await model("write", { path: path("binary"), content: "!!", encoding: "base64" }),
        ).toMatchObject({ isError: true, errorKind: "precondition_failed" });
        await writeFile(join(root, "text"), "aaa");
        for (const oldText of ["missing", "aa"])
          expect(
            await model("edit", { path: path("text"), edits: [{ oldText, newText: "x" }] }),
          ).toMatchObject({
            isError: true,
            errorKind: "precondition_failed",
          });
        expect(await readFile(join(root, "text"), "utf8")).toBe("aaa");
        expect(await model("read", { path: path("absent") })).toMatchObject({
          isError: true,
          errorKind: "precondition_failed",
        });
        const content = "x".repeat(1_100_000);
        await writeFile(join(root, "large"), content);
        expect((await cell("read", { path: path("large") })).output).toEqual({
          content,
          bytes: content.length,
        });
        const rendered = await model("read", { path: path("large") });
        expect(rendered.output).toHaveLength(32_000);
        expect(rendered.output).toContain("truncated:");
        expect(rendered.output).toContain("1100000 bytes original");
      });
    });
    test("bash returns stdout, stderr, exit status and has no persistent cwd", async () => {
      await fixture(remote, async ({ root, cell }) => {
        const machine: Record<string, PlainValue> = remote ? { machine: "c" } : {};
        expect(
          (
            await cell("bash", {
              command: `cd '${root}'; printf out; printf err >&2; exit 7`,
              ...machine,
            })
          ).output,
        ).toEqual({
          stdout: "out",
          stderr: "err",
          exitCode: 7,
          signal: null,
          truncated: false,
          timedOut: false,
        });
        expect(
          (await cell("bash", { command: "printf '%s' \"$PWD\"", ...machine })).output,
        ).toMatchObject({ stdout: remote ? "/" : process.cwd(), exitCode: 0 });
      });
    });
  });
}

test("R1 bash rejects composite machine IDs before endpoint lookup even with an allowed cwd", async () => {
  await fixture(true, async ({ root, rawExec, endpointCalls, model }) => {
    const injected = join(root, "injected:");
    await mkdir(injected);
    const command = "printf '%s' \"$PWD\"";
    // Prove the real daemon would allow the malformed locus's cwd: denial must be in the adapter.
    expect(await rawExec(command, injected)).toMatchObject({
      status: "completed",
      stdout: Buffer.from(await realpath(injected)),
      exitCode: 0,
    });
    for (const machine of [`c:${root}/injected`, "c:/", "c/path", "./c"]) {
      const before = endpointCalls();
      expect(await model("bash", { machine, command })).toMatchObject({
        isError: true,
        errorKind: "precondition_failed",
      });
      expect(endpointCalls()).toEqual(before);
    }
    expect((await model("bash", { machine: "c", command })).isError).toBeUndefined();
  });
});

test.each([
  ".",
  "./",
])("R2 recursive search preserves local colon escapes under %s", async (path) => {
  await fixture(false, async ({ root, cell, model, endpointCalls }) => {
    await writeFile(join(root, "a:b"), "needle in file\n");
    await mkdir(join(root, "d:e"));
    await writeFile(join(root, "d:e", "f:g"), "needle in directory\n");
    const absolute = await cell("grep", { path: root, pattern: "needle" });
    expect(absolute.output).toEqual({
      matches: [
        { path: join(root, "a:b"), line: 1, text: "needle in file", before: [], after: [] },
        {
          path: join(root, "d:e", "f:g"),
          line: 1,
          text: "needle in directory",
          before: [],
          after: [],
        },
      ],
      truncated: false,
    });
    const before = endpointCalls();
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const relative = await cell("grep", { path, pattern: "needle" });
      expect(relative.isError).toBeUndefined();
      expect(relative.output).toEqual({
        matches: [
          { path: "./a:b", line: 1, text: "needle in file", before: [], after: [] },
          { path: "./d:e/f:g", line: 1, text: "needle in directory", before: [], after: [] },
        ],
        truncated: false,
      });
      expect((await model("grep", { path, pattern: "needle" })).output).toBe(
        "./a:b:1:needle in file\n./d:e/f:g:1:needle in directory",
      );
      expect((await cell("find", { path, pattern: "d:e/*" })).output).toEqual({
        paths: ["./d:e/f:g"],
        truncated: false,
      });
      expect(endpointCalls()).toEqual(before);
    } finally {
      process.chdir(cwd);
    }
  });
});

test("R3 real daemon Unicode read preserves cells and reports exact dropped bytes to the model", async () => {
  await fixture(true, async ({ root, path, cell, model }) => {
    const content = `a${"\u{1F600}".repeat(25_000)}`;
    await writeFile(join(root, "unicode"), content);
    expect((await cell("read", { path: path("unicode") })).output).toEqual({
      content,
      bytes: 100_001,
    });
    const result = await model("read", { path: path("unicode") });
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe(
      `a${"\u{1F600}".repeat(15_971)}\n[truncated: 36116 bytes dropped; 100001 bytes original]`,
    );
    expect(Buffer.from(result.output, "utf8").toString("utf8")).toBe(result.output);
  });
});

test("a real daemon read assembles successive bounded chunks without dropping the tail", async () => {
  await fixture(true, async ({ root, path, cell }) => {
    const content = `${"a".repeat(Machine.FS_READ_MAX_BYTES)}TAIL_SENTINEL`;
    await writeFile(join(root, "chunked"), content);
    expect((await cell("read", { path: path("chunked") })).output).toEqual({
      content, bytes: Buffer.byteLength(content),
    });
  });
});

test("a truncated remote read without progress is refused instead of looping", async () => {
  await fixture(true, async ({ machine, path, model }) => {
    const read = spyOn(machine.fs, "read").mockResolvedValue({
      op: "read", data: new Uint8Array(), bytesRead: 0, size: 1, truncated: true,
    });
    try {
      const result = await model("read", { path: path("stalled") });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("remote read made no progress");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });
});

test("daemon authority refuses writes and exec independently of the catalog", async () => {
  await fixture(
    true,
    async ({ path, model }) => {
      expect(await model("write", { path: path("denied"), content: "x" })).toMatchObject({
        isError: true,
        errorKind: "precondition_failed",
      });
      expect(await model("bash", { machine: "c", command: "true" })).toMatchObject({
        isError: true,
        errorKind: "precondition_failed",
      });
    },
    ["fs.read"],
  );
});

test("missing machine host and malformed machine ids yield typed refusals", async () => {
  const dispatcher = createDispatcher(createTools({}, origin), { executor });
  for (const [tool, input] of [
    ["read", { path: "c:/file" }],
    ["bash", { machine: "c", command: "true" }],
    ["bash", { machine: "./bad", command: "true" }],
  ] as const) {
    expect(await dispatcher.execute({ id: tool, tool, input }, context)).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
    });
  }
});
