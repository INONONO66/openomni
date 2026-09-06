import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasExecutableSource } from "./check-coverage-ratchet";

const ownedSources = [
  ...new Bun.Glob("*.{ts,tsx}").scanSync({ cwd: import.meta.dir, onlyFiles: true }),
]
  .filter(
    (file) =>
      !/\.(test|spec)\.tsx?$/.test(file) && hasExecutableSource(join(import.meta.dir, file)),
  )
  .sort();

test("every owned script source is loaded for coverage", async () => {
  for (const source of ownedSources) {
    await import(new URL(source, `${import.meta.url}/../`).href);
  }

  expect(ownedSources.length).toBeGreaterThan(0);
});

test("inventory exempts erased TypeScript and re-export-only barrels", () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-source-syntax-"));
  try {
    const examples = [
      ["interface.ts", "export interface A { value: number }; export type B = A;", false],
      ["types.ts", 'import type { A } from "./a"; export type { A };', false],
      ["named-types.ts", 'import { type A } from "./a"; export { type A };', false],
      ["ambient.d.ts", "declare const value: number;", false],
      ["declare.ts", "declare function value(): number;", false],
      ["empty.ts", "export {};", false],
      ["enum.ts", "export enum Value { One }", true],
      ["component.tsx", "export const Component = () => <div />;", true],
      ["barrel.ts", 'export { value } from "./value";', false],
      ["star-barrel.ts", 'export * from "./value";', false],
      ["mixed-barrel.ts", 'export * from "./value"; export const call = () => 1;', true],
      ["effect.ts", 'import "./effect";', true],
      ["export-effect.ts", 'export {} from "./effect";', true],
    ] as const;
    for (const [name, source, executable] of examples) {
      const path = join(root, name);
      writeFileSync(path, source);
      expect(hasExecutableSource(path)).toBe(executable);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
