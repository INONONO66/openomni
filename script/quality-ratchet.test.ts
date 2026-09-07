import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineAt, changedSources, regressions, touchedFindings } from "./quality-ratchet";

const row = { gate: "publisher" as const, path: "packages/a/src/event.ts", line: 1, symbol: "Ready", value: 1 };
const snapshot = (findings = [row]) => ({ version: 1 as const, complete: true as const, analyzed: ["publisher" as const], inventory: [row.path], findings });

test("ratchets only shrink; new findings, value growth and findings in modified files fail", () => {
  const base = snapshot();
  expect(regressions(base, snapshot([]), new Set())).toEqual([]);
  expect(regressions(base, base, new Set())).toEqual([]);
  for (const current of [snapshot([{ ...row, value: 2 }]), snapshot([row, row]), snapshot([{ ...row, symbol: "Other" }])])
    expect(regressions(base, current, new Set()).length).toBeGreaterThan(0);
  expect(regressions(base, base, new Set([row.path]))).toEqual([row]);
  expect(regressions(base, snapshot([{ ...row, line: 9 }]), new Set())).toEqual([]);
  expect(() => regressions(base, { ...base, inventory: [] }, new Set())).toThrow();
  expect(() => regressions(base, { ...base, analyzed: [] }, new Set())).toThrow();
});

test("actual Git diff includes added/modified owned source, never generated or deleted files", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-ratchet-git-"));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode).toBe(0);
  };
  try {
    mkdirSync(join(root, "script"));
    writeFileSync(join(root, "script/old.ts"), "export const kept = 1;\nexport const value = 1;\n");
    writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
    writeFileSync(join(root, "contract.json"), JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false }));
    const original = { ...snapshot([{ ...row, path: "script/old.ts" }]), inventory: ["script/old.ts"] };
    writeFileSync(join(root, "baseline.json"), JSON.stringify(original));
    git(["init", "-q"]);
    git(["add", "."]);
    // A fixture-only commit establishes a real comparison tree; never a product commit.
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    writeFileSync(join(root, "script/old.ts"), "export const kept = 1;\nexport const value = 2;\n");
    writeFileSync(join(root, "script/new.ts"), "export const added = 1;\n");
    mkdirSync(join(root, "script/generated"));
    writeFileSync(join(root, "script/generated/out.ts"), "export const generated = 1;\n");
    expect([...changedSources(root, "HEAD")].sort()).toEqual(["script/new.ts", "script/old.ts"]);
    const untouched = { ...row, path: "script/old.ts", line: 1 };
    const edited = { ...untouched, line: 2 };
    const added = { ...row, path: "script/new.ts" };
    expect(touchedFindings(root, "HEAD", [untouched, edited, added])).toEqual([edited, added]);
    const current = { ...original, inventory: ["script/new.ts", "script/old.ts"] };
    const cli = join(import.meta.dir, "quality-ratchet.ts");
    const invoke = () => Bun.spawnSync([process.execPath, cli, "--root", root, "--base", "HEAD", "--baseline", "baseline.json", "--current", "current.json", "--contract", "contract.json"]).exitCode;
    writeFileSync(join(root, "current.json"), JSON.stringify(current));
    expect(invoke()).toBe(0);
    writeFileSync(join(root, "current.json"), JSON.stringify({ ...current, findings: [edited] }));
    expect(invoke()).toBe(1);
    writeFileSync(join(root, "current.json"), JSON.stringify({ ...current, complete: false }));
    expect(invoke()).toBe(2);
    writeFileSync(join(root, "current.json"), JSON.stringify({ ...current, findings: [{ ...untouched, value: 2 }] }));
    writeFileSync(join(root, "baseline.json"), JSON.stringify({ ...original, findings: [{ ...untouched, value: 2 }] }));
    expect(invoke()).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("compacted baseline multiplicities cannot conceal new or higher-severity findings", () => {
  const base = { ...snapshot(), findings: [{ ...row, value: 10, count: 2 }] };
  expect(regressions(base, snapshot([{ ...row, value: 9 }, { ...row, value: 8 }]), new Set())).toEqual([]);
  expect(regressions(base, snapshot([row, row, row]), new Set())).toHaveLength(3);
  expect(regressions(base, snapshot([{ ...row, value: 11 }]), new Set())).toHaveLength(1);
});

test("fragment baselines are read from the compared Git revision, not editable working files", () => {
  const root = mkdtempSync(join(tmpdir(), "ratchet-fragments-"));
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(child.exitCode).toBe(0);
  };
  try {
    const { findings, ...header } = snapshot();
    writeFileSync(join(root, "index.json"), JSON.stringify({ ...header, fragments: ["rows.json"] }));
    writeFileSync(join(root, "rows.json"), JSON.stringify(findings));
    git(["init", "-q"]);
    git(["add", "."]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline"]);
    writeFileSync(join(root, "rows.json"), JSON.stringify([{ ...row, count: 2 }]));
    const prior = baselineAt(root, "index.json", "HEAD");
    const candidate = baselineAt(root, "index.json");
    expect(prior.findings).toEqual([row]);
    expect(regressions(prior, candidate, new Set())).toHaveLength(1);
    writeFileSync(join(root, "index.json"), JSON.stringify({ ...header, fragments: ["../outside.json"] }));
    expect(() => baselineAt(root, "index.json")).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
