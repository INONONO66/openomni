import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createReadTool } from "../src/tool/builtins/read";
import { createWriteTool } from "../src/tool/builtins/write";
import { bashTool } from "../src/tool/builtins/bash";
import { SystemToolProvider } from "../src/tool/system/provider";
import type { Tool } from "@openomni/protocol";

const tmpRoot = join(import.meta.dir, ".tmp-workspace-test");
const workspace = join(tmpRoot, "workspace");
const outside = join(tmpRoot, "outside");

function makeCall(tool: string, input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool, input };
}

beforeAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(join(workspace, "subdir"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, "test.txt"), "hello");
  writeFileSync(join(outside, "secret.txt"), "sensitive");
  symlinkSync(outside, join(workspace, "escape-link"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("read containment", () => {
  const read = createReadTool(workspace);

  it("allows reading files inside workspace", async () => {
    const result = await read.execute(makeCall("read", { path: "test.txt" }));
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("1: hello");
  });

  it("lists directory contents within workspace", async () => {
    const result = await read.execute(makeCall("read", { path: "." }));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("test.txt");
    expect(result.output).toContain("subdir/");
  });

  it("blocks listing directories outside workspace via traversal", async () => {
    const result = await read.execute(makeCall("read", { path: "../outside" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks reading files outside workspace", async () => {
    const result = await read.execute(makeCall("read", { path: "/etc/passwd" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks path traversal via ../", async () => {
    const result = await read.execute(makeCall("read", { path: "../../etc/passwd" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks symlink escape", async () => {
    const result = await read.execute(makeCall("read", { path: "escape-link/secret.txt" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("symlink");
  });
});

describe("write containment", () => {
  const write = createWriteTool(workspace);

  it("blocks write outside workspace via traversal", async () => {
    const result = await write.execute(
      makeCall("write", { path: "../outside/hack.txt", content: "pwned" }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });
});

describe("bash containment", () => {
  const bash = bashTool(workspace);

  it("runs commands from workspace root by default", async () => {
    const result = await bash.execute(makeCall("bash", { command: "pwd" }));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(workspace);
  });

  it("blocks workdir outside workspace", async () => {
    const result = await bash.execute(makeCall("bash", { command: "pwd", workdir: "/tmp" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks workdir traversal", async () => {
    const result = await bash.execute(makeCall("bash", { command: "pwd", workdir: "../../" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("allows workdir inside workspace", async () => {
    const result = await bash.execute(makeCall("bash", { command: "pwd", workdir: "subdir" }));
    expect(result.isError).toBeFalsy();
  });
});

describe("SystemToolProvider tool filtering", () => {
  it("omits file tools when workspace root is not set", () => {
    const provider = new SystemToolProvider();
    const names = provider.listTools().map((t) => t.spec.name);

    expect(names).toContain("bash");
    expect(names).not.toContain("read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("grep.search");
    expect(names).not.toContain("glob");
  });

  it("includes all tools when workspace root is set", () => {
    const provider = new SystemToolProvider(workspace);
    const names = provider.listTools().map((t) => t.spec.name);

    expect(names).toContain("bash");
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("grep.search");
    expect(names).toContain("glob");
  });
});
