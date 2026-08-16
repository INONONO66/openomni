import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { InstructionLoader } from "../../src/context/instructions";

let tempRoot: string;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "instructions-test-")));
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeWorkspace(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("InstructionLoader.discover", () => {
  it("discovers AGENTS.md in workspace root via findUp", () => {
    const ws = makeWorkspace("discover-project");
    writeFileSync(join(ws, "AGENTS.md"), "# Project instructions");

    const files = InstructionLoader.discover(ws, "trace-instr-test");
    const project = files.find((f) => f.label === "Project");
    expect(project).toBeDefined();
    expect(project?.path).toBe(join(ws, "AGENTS.md"));
    expect(project?.priority).toBe(10);
  });

  it("discovers global AGENTS.md from custom globalConfigDir", () => {
    const ws = makeWorkspace("discover-global");
    const globalDir = makeWorkspace("global-config");
    writeFileSync(join(globalDir, "AGENTS.md"), "# Global instructions");

    const files = InstructionLoader.discover(ws, "trace-instr-test", globalDir);
    const global = files.find((f) => f.label === "Global");
    expect(global).toBeDefined();
    expect(global?.path).toBe(join(globalDir, "AGENTS.md"));
    expect(global?.priority).toBe(0);
  });

  it("discovers AGENTS.local.md in workspace root (existsSync only, no findUp)", () => {
    const ws = makeWorkspace("discover-local");
    writeFileSync(join(ws, "AGENTS.local.md"), "# Local instructions");

    // Also put AGENTS.local.md in a parent dir — it should NOT be found (no findUp)
    const subdir = join(ws, "subdir");
    mkdirSync(subdir);

    const files = InstructionLoader.discover(ws, "trace-instr-test");
    const local = files.find((f) => f.label === "Local");
    expect(local).toBeDefined();
    expect(local?.path).toBe(join(ws, "AGENTS.local.md"));
    expect(local?.priority).toBe(20);

    // Subdirectory should NOT find parent's AGENTS.local.md
    const subdirFiles = InstructionLoader.discover(subdir, "trace-instr-test");
    expect(subdirFiles.find((f) => f.label === "Local")).toBeUndefined();
  });

  it("discovers all .md files in .openomni/rules/", () => {
    const ws = makeWorkspace("discover-rules");
    const rulesDir = join(ws, ".openomni", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "coding.md"), "# Coding rules");
    writeFileSync(join(rulesDir, "testing.md"), "# Testing rules");
    writeFileSync(join(rulesDir, "not-markdown.txt"), "ignored");

    const files = InstructionLoader.discover(ws, "trace-instr-test");
    const ruleLabels = files.filter((f) => f.label.startsWith("Rules:")).map((f) => f.label);
    expect(ruleLabels).toContain("Rules: coding.md");
    expect(ruleLabels).toContain("Rules: testing.md");
    expect(ruleLabels).not.toContain("Rules: not-markdown.txt");
  });

  it("sorts by priority: global(0) < project(10) < rules(15) < local(20)", () => {
    const ws = makeWorkspace("discover-priority");
    const globalDir = makeWorkspace("priority-global-config");
    writeFileSync(join(globalDir, "AGENTS.md"), "# Global");
    writeFileSync(join(ws, "AGENTS.md"), "# Project");
    writeFileSync(join(ws, "AGENTS.local.md"), "# Local");
    const rulesDir = join(ws, ".openomni", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "rule.md"), "# Rule");

    const files = InstructionLoader.discover(ws, "trace-instr-test", globalDir);
    const priorities = files.map((f) => f.priority);

    for (let i = 1; i < priorities.length; i++) {
      const prev = priorities[i - 1];
      const curr = priorities[i];
      if (prev === undefined || curr === undefined) throw new Error("shape");
      expect(curr).toBeGreaterThanOrEqual(prev);
    }

    expect(files[0]?.label).toBe("Global");
    expect(files[files.length - 1]?.label).toBe("Local");
  });

  it("returns [] for empty directory with no relevant files", () => {
    const ws = makeWorkspace("discover-empty");
    const files = InstructionLoader.discover(ws, "trace-instr-test");
    expect(files).toEqual([]);
  });

  it("skips global AGENTS.md when globalConfigDir has none", () => {
    const ws = makeWorkspace("discover-no-global");
    const globalDir = makeWorkspace("empty-global-config");
    const files = InstructionLoader.discover(ws, "trace-instr-test", globalDir);
    expect(files.find((f) => f.label === "Global")).toBeUndefined();
  });
});

describe("InstructionLoader.load", () => {
  it("returns empty string for empty file list", () => {
    expect(InstructionLoader.load([], "trace-instr-test")).toBe("");
  });

  it("returns content with section header for one file", () => {
    const ws = makeWorkspace("load-one");
    const filePath = join(ws, "AGENTS.md");
    writeFileSync(filePath, "Hello world");

    const result = InstructionLoader.load(
      [{ path: filePath, priority: 10, label: "Project" }],
      "trace-instr-test",
    );
    expect(result).toContain("**Instructions from Project:**");
    expect(result).toContain("Hello world");
  });

  it("truncates file content at 12,000 chars", () => {
    const ws = makeWorkspace("load-truncate");
    const filePath = join(ws, "big.md");
    const bigContent = "x".repeat(13_000);
    writeFileSync(filePath, bigContent);

    const result = InstructionLoader.load(
      [{ path: filePath, priority: 0, label: "Big" }],
      "trace-instr-test",
    );
    expect(result).toContain("[...truncated]");
    const xCount = (result.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(12_000);
  });

  it("skips unreadable file silently and continues", async () => {
    const ws = makeWorkspace("load-unreadable");
    const goodPath = join(ws, "good.md");
    const badPath = join(ws, "nonexistent.md");
    writeFileSync(goodPath, "Good content");

    // Pin (D11): the skip-warn INHERITS the caller's dispatch trace — a
    // revert to a per-warn mint would break this equality.
    const warns: Array<{ traceId: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (event) => {
      warns.push(event);
    });
    let result: string;
    try {
      result = InstructionLoader.load(
        [
          { path: badPath, priority: 0, label: "Bad" },
          { path: goodPath, priority: 10, label: "Good" },
        ],
        "trace-unreadable-pin",
      );
    } finally {
      // Bus handlers are dispatched via queueMicrotask — flush before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      unsubscribe();
    }

    expect(result).toContain("Good content");
    expect(result).not.toContain("ENOENT");
    expect(warns.map((w) => w.traceId)).toEqual(["trace-unreadable-pin"]);
  });

  it("assembles multiple files in order with separators", () => {
    const ws = makeWorkspace("load-multi");
    const file1 = join(ws, "a.md");
    const file2 = join(ws, "b.md");
    writeFileSync(file1, "Alpha content");
    writeFileSync(file2, "Beta content");

    const result = InstructionLoader.load(
      [
        { path: file1, priority: 0, label: "Alpha" },
        { path: file2, priority: 10, label: "Beta" },
      ],
      "trace-instr-test",
    );

    const alphaPos = result.indexOf("Alpha content");
    const betaPos = result.indexOf("Beta content");
    expect(alphaPos).toBeGreaterThanOrEqual(0);
    expect(betaPos).toBeGreaterThanOrEqual(0);
    expect(alphaPos).toBeLessThan(betaPos);
    expect(result).toContain("---");
  });
});

describe("InstructionLoader caching", () => {
  it("discover returns cached result on repeated calls", () => {
    const ws = makeWorkspace("cache-discover");
    writeFileSync(join(ws, "AGENTS.md"), "# Original");

    const first = InstructionLoader.discover(ws, "trace-instr-test", ws);
    const second = InstructionLoader.discover(ws, "trace-instr-test", ws);
    expect(second).toBe(first);
  });

  it("discover returns stale global result after file deletion for the same cache key", () => {
    const ws = makeWorkspace("cache-stale-discover");
    const globalDir = makeWorkspace("cache-stale-global-config");
    const agentsPath = join(globalDir, "AGENTS.md");
    writeFileSync(agentsPath, "# Will be deleted");

    const first = InstructionLoader.discover(ws, "trace-instr-test", globalDir);
    expect(first.some((f) => f.label === "Global")).toBe(true);

    unlinkSync(agentsPath);

    const cached = InstructionLoader.discover(ws, "trace-instr-test", globalDir);
    expect(cached.some((f) => f.label === "Global")).toBe(true);

    const freshGlobalDir = makeWorkspace("cache-stale-fresh-global-config");
    const fresh = InstructionLoader.discover(ws, "trace-instr-test", freshGlobalDir);
    expect(fresh.some((f) => f.label === "Global")).toBe(false);
  });

  it("load returns cached result on repeated calls with the same file list", () => {
    const ws = makeWorkspace("cache-load");
    const filePath = join(ws, "test.md");
    writeFileSync(filePath, "Content A");

    const files = [{ path: filePath, priority: 0, label: "Test" }];
    const first = InstructionLoader.load(files, "trace-instr-test");
    expect(first).toContain("Content A");

    writeFileSync(filePath, "Content B");

    const cached = InstructionLoader.load(files, "trace-instr-test");
    expect(cached).toContain("Content A");

    const freshPath = join(ws, "fresh.md");
    writeFileSync(freshPath, "Content B");
    const fresh = InstructionLoader.load(
      [{ path: freshPath, priority: 0, label: "Fresh" }],
      "trace-instr-test",
    );
    expect(fresh).toContain("Content B");
  });
});
