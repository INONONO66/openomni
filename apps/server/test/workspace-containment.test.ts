import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFilesystemTools } from "../src/tool/system/tools/filesystem";
import { createGitTools } from "../src/tool/system/tools/git";
import { createShellTool } from "../src/tool/system/tools/shell";
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

describe("filesystem containment", () => {
  const tools = createFilesystemTools(workspace);
  const read = tools.find((t) => t.spec.name === "fs.read");
  const write = tools.find((t) => t.spec.name === "fs.write");
  const list = tools.find((t) => t.spec.name === "fs.list");
  if (!read || !write || !list) throw new Error("expected fs tools not found");

  it("allows reading files inside workspace", async () => {
    const result = await read.execute(makeCall("fs.read", { path: "test.txt" }));
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("hello");
  });

  it("blocks reading files outside workspace", async () => {
    const result = await read.execute(makeCall("fs.read", { path: "/etc/passwd" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks path traversal via ../", async () => {
    const result = await read.execute(makeCall("fs.read", { path: "../../etc/passwd" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks symlink escape", async () => {
    const result = await read.execute(makeCall("fs.read", { path: "escape-link/secret.txt" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("symlink");
  });

  it("blocks write outside workspace via traversal", async () => {
    const result = await write.execute(
      makeCall("fs.write", { path: "../outside/hack.txt", content: "pwned" }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks list outside workspace", async () => {
    const result = await list.execute(makeCall("fs.list", { path: "/tmp" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });
});

describe("git containment", () => {
  const tools = createGitTools(workspace);
  const status = tools.find((t) => t.spec.name === "git.status");
  if (!status) throw new Error("expected git.status tool not found");

  it("blocks workdir outside workspace", async () => {
    const result = await status.execute(makeCall("git.status", { workdir: "/tmp" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks workdir traversal", async () => {
    const result = await status.execute(makeCall("git.status", { workdir: "../../" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("allows workdir inside workspace", async () => {
    const result = await status.execute(makeCall("git.status", { workdir: "subdir" }));
    expect(result.output).toBeDefined();
  });
});

describe("shell containment", () => {
  const shell = createShellTool(workspace);

  it("blocks workdir outside workspace", async () => {
    const result = await shell.execute(makeCall("shell.exec", { command: "pwd", workdir: "/tmp" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });
});

describe("SystemToolProvider tool filtering", () => {
  it("omits fs and git tools when workspace root is not set", () => {
    const provider = new SystemToolProvider();
    const names = provider.listTools().map((t) => t.spec.name);

    expect(names).not.toContain("fs.read");
    expect(names).not.toContain("git.status");
    expect(names).toContain("shell.exec");
  });

  it("includes fs and git tools when workspace root is set", () => {
    const provider = new SystemToolProvider(workspace);
    const names = provider.listTools().map((t) => t.spec.name);

    expect(names).toContain("fs.read");
    expect(names).toContain("git.status");
    expect(names).toContain("shell.exec");
  });
});
