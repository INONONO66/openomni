import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, ToolRefused } from "@openomni/agent";
import { attachMachineDaemon, createMachineHost } from "@openomni/machines";
import type { PlainValue } from "@openomni/protocol";
import { createTools } from "../src/tools/core/catalog";
import { parseLocus } from "../src/tools/locus";
import { socketPath } from "../../../packages/machines/test/helpers/socket-path";
import { executor } from "./helpers/executor";

const origin = { role: "resident", depth: 0, sessionId: "locus" } as const;
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
    list: ["list"],
    search: ["stat", "read"],
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
        expect(
          (await cell("edit", { path: file, oldText: "beta", newText: "gamma" })).output,
        ).toEqual({ bytesWritten: 12 });
        expect(await readFile(join(root, "file"), "utf8")).toBe("alpha\ngamma\n");
        expect((await cell("list", { path: path(".") })).output).toEqual([
          { name: "file", kind: "file" },
        ]);
        await mkdir(join(root, "nested"));
        await writeFile(join(root, "nested", "file"), "gamma in nested\n");
        await symlink(root, join(root, "loop"));
        expect((await cell("search", { path: path("."), pattern: "gamma" })).output).toEqual([
          { path: file, line: 2, text: "gamma" },
          { path: path("nested/file"), line: 1, text: "gamma in nested" },
        ]);
        expect((await cell("search", { path: file, pattern: "a.*" })).output).toEqual([]);
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
          expect(await model("edit", { path: path("text"), oldText, newText: "x" })).toMatchObject({
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
        expect(rendered.output).toContain("1100000 chars original");
      });
    });
    test("bash returns stdout, stderr, exit status and has no persistent cwd", async () => {
      await fixture(remote, async ({ root, cell }) => {
        const machine: Record<string, PlainValue> = remote ? { machine: "c" } : {};
        expect(
          (
            await cell("bash", {
              cmd: `cd '${root}'; printf out; printf err >&2; exit 7`,
              ...machine,
            })
          ).output,
        ).toEqual({ stdout: "out", stderr: "err", exitCode: 7, signal: null, truncated: false });
        expect(
          (await cell("bash", { cmd: "printf '%s' \"$PWD\"", ...machine })).output,
        ).toMatchObject({ stdout: remote ? "/" : process.cwd(), exitCode: 0 });
      });
    });
  });
}

test("daemon authority refuses writes and exec independently of the catalog", async () => {
  await fixture(
    true,
    async ({ path, model }) => {
      expect(await model("write", { path: path("denied"), content: "x" })).toMatchObject({
        isError: true,
        errorKind: "precondition_failed",
      });
      expect(await model("bash", { machine: "c", cmd: "true" })).toMatchObject({
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
    ["bash", { machine: "c", cmd: "true" }],
    ["bash", { machine: "./bad", cmd: "true" }],
  ] as const) {
    expect(await dispatcher.execute({ id: tool, tool, input }, context)).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
    });
  }
});
