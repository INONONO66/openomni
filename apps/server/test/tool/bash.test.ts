import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { bashTool, isDestructiveCommand, isReadOnlyCommand } from "../../src/tool/builtins/bash";

const tmpRoot = join(import.meta.dir, ".tmp-bash-test");
const workspace = join(tmpRoot, "workspace");

function makeCall(input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool: "bash", input };
}

beforeAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "hello.txt"), "hi");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("bashTool execution", () => {
  it("executes a simple command and returns stdout", async () => {
    const tool = bashTool(workspace);
    const result = await tool.execute(makeCall({ command: "ls" }));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("hello.txt");
  });

  it("blocks workspace escape via absolute workdir outside root", async () => {
    const tool = bashTool(workspace);
    const result = await tool.execute(makeCall({ command: "cat passwd", workdir: "/etc" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("blocks workspace escape via relative traversal", async () => {
    const tool = bashTool(workspace);
    const result = await tool.execute(makeCall({ command: "ls", workdir: "../outside" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("kills process on timeout", async () => {
    const tool = bashTool(workspace);
    const result = await tool.execute(makeCall({ command: "sleep 5", timeoutMs: 200 }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("timed out");
  });

  it("returns error on non-zero exit", async () => {
    const tool = bashTool(workspace);
    const result = await tool.execute(makeCall({ command: "exit 2" }));
    expect(result.isError).toBe(true);
  });

  it("rejects empty command input", async () => {
    const tool = bashTool(workspace);
    const result = await tool.execute(makeCall({ command: "" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command");
  });
});

describe("isReadOnlyCommand", () => {
  it("classifies git status as read-only", () => {
    expect(isReadOnlyCommand("git status")).toBe(true);
  });

  it("classifies git log as read-only", () => {
    expect(isReadOnlyCommand("git log --oneline")).toBe(true);
  });

  it("classifies git diff as read-only", () => {
    expect(isReadOnlyCommand("git diff HEAD")).toBe(true);
  });

  it("classifies git push as not read-only", () => {
    expect(isReadOnlyCommand("git push")).toBe(false);
  });

  it("classifies ls as read-only", () => {
    expect(isReadOnlyCommand("ls -la")).toBe(true);
  });

  it("classifies cat as read-only", () => {
    expect(isReadOnlyCommand("cat README.md")).toBe(true);
  });

  it("classifies rm as not read-only", () => {
    expect(isReadOnlyCommand("rm foo")).toBe(false);
  });

  it("classifies empty string as not read-only", () => {
    expect(isReadOnlyCommand("")).toBe(false);
  });

  it("classifies git branch as not read-only because -D/-m can mutate", () => {
    expect(isReadOnlyCommand("git branch -D feature")).toBe(false);
    expect(isReadOnlyCommand("git branch")).toBe(false);
  });

  it("classifies git remote add as not read-only", () => {
    expect(isReadOnlyCommand("git remote add origin https://example.com/repo")).toBe(false);
  });

  it("classifies git tag -d as not read-only", () => {
    expect(isReadOnlyCommand("git tag -d v1.0")).toBe(false);
  });

  it("rejects read-only classification when chained with && rm", () => {
    expect(isReadOnlyCommand("ls && rm -rf /")).toBe(false);
  });

  it("rejects read-only classification when piped to destructive command", () => {
    expect(isReadOnlyCommand("ls | xargs rm")).toBe(false);
  });

  it("rejects read-only classification with redirect", () => {
    expect(isReadOnlyCommand("cat file > /etc/passwd")).toBe(false);
  });

  it("rejects read-only classification with command substitution", () => {
    expect(isReadOnlyCommand("echo `rm -rf /`")).toBe(false);
    expect(isReadOnlyCommand("echo $(rm -rf /)")).toBe(false);
  });

  it("rejects read-only classification with semicolon chain", () => {
    expect(isReadOnlyCommand("ls; rm foo")).toBe(false);
  });
});

describe("isDestructiveCommand", () => {
  it("classifies rm -rf as destructive", () => {
    expect(isDestructiveCommand("rm -rf /")).toBe(true);
  });

  it("classifies rm -r as destructive", () => {
    expect(isDestructiveCommand("rm -r dir")).toBe(true);
  });

  it("classifies plain rm as not destructive", () => {
    expect(isDestructiveCommand("rm foo")).toBe(false);
  });

  it("classifies git push as destructive", () => {
    expect(isDestructiveCommand("git push origin main")).toBe(true);
  });

  it("classifies git reset --hard as destructive", () => {
    expect(isDestructiveCommand("git reset --hard HEAD~1")).toBe(true);
  });

  it("classifies git clean -f as destructive", () => {
    expect(isDestructiveCommand("git clean -fd")).toBe(true);
  });

  it("classifies mv as destructive", () => {
    expect(isDestructiveCommand("mv src dst")).toBe(true);
  });

  it("classifies chmod as destructive", () => {
    expect(isDestructiveCommand("chmod 755 file")).toBe(true);
  });

  it("classifies ls as not destructive", () => {
    expect(isDestructiveCommand("ls")).toBe(false);
  });

  it("classifies echo as not destructive", () => {
    expect(isDestructiveCommand("echo hello")).toBe(false);
  });

  it("classifies git status as not destructive", () => {
    expect(isDestructiveCommand("git status")).toBe(false);
  });
});

describe("bashTool metadata callbacks", () => {
  it("evaluates isReadOnly dynamically from input", () => {
    const tool = bashTool(workspace);
    const meta = tool.isReadOnly;
    if (typeof meta !== "function") throw new Error("expected isReadOnly to be a function");
    expect(meta({ command: "git status" })).toBe(true);
    expect(meta({ command: "git push" })).toBe(false);
  });

  it("evaluates isDestructive dynamically from input", () => {
    const tool = bashTool(workspace);
    const meta = tool.isDestructive;
    if (typeof meta !== "function") throw new Error("expected isDestructive to be a function");
    expect(meta({ command: "rm -rf /" })).toBe(true);
    expect(meta({ command: "ls" })).toBe(false);
  });

  it("omits static safe flag from spec when classification is dynamic", () => {
    const tool = bashTool(workspace);
    expect(tool.spec.safe).toBeUndefined();
  });

  it("exposes the prompt via the tool spec", () => {
    const tool = bashTool(workspace);
    expect(tool.spec.prompt).toBeDefined();
    expect(typeof tool.spec.prompt).toBe("string");
  });
});
