import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { censusMain } from "./check-census";

export const cli = join(import.meta.dir, "check-census.ts");
const knip = resolve(import.meta.dir, "../node_modules/knip/bin/knip.js");
export function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
export class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), "census-fixture-"));
  readonly sources: Record<string, string>;
  constructor(sources: Record<string, string>) {
    this.sources = sources;
    this.write(
      "package.json",
      JSON.stringify({
        name: "census-fixture",
        private: true,
        scripts: { start: "bun src/main.ts" },
      }),
    );
    this.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "preserve",
          moduleResolution: "bundler",
          target: "esnext",
        },
        include: ["src", "test"],
      }),
    );
    for (const [path, content] of Object.entries(sources)) this.write(path, content);
    this.freeze();
  }
  write(path: string, content: string): void {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), content);
  }
  freeze(omit: string[] = []): void {
    const contract = {
      version: 1,
      typescript: "5.9.2",
      roots: ["src", "test"],
      projects: ["tsconfig.json"],
      topology: false,
    };
    this.write("contract.json", JSON.stringify(contract));
    this.write(
      "inventory.json",
      JSON.stringify({
        version: 1,
        contractHash: hash(JSON.stringify(contract)),
        files: Object.entries(this.sources)
          .filter(([path]) => !omit.includes(path))
          .sort()
          .map(([path, content]) => ({
            path,
            sha256: hash(content),
            bytes: Buffer.byteLength(content),
            category: path.startsWith("test/") ? "test" : "production",
            language: path.endsWith(".py")
              ? "python"
              : path.endsWith(".js")
                ? "javascript"
                : "typescript",
          })),
        historical: [],
        embedded: [],
        configurations: [
          { path: "tsconfig.json", sha256: hash(readFileSync(join(this.root, "tsconfig.json"))) },
        ],
      }),
    );
  }
  schema(sql = "CREATE TABLE item (id INTEGER PRIMARY KEY)"): string[] {
    for (const name of ["fresh.db", "upgraded.db"]) {
      using db = new Database(join(this.root, name));
      db.exec(sql);
    }
    return [
      "--schema",
      "fresh.db",
      "--schema-sha256",
      hash(readFileSync(join(this.root, "fresh.db"))),
      "--upgraded-schema",
      "upgraded.db",
      "--upgraded-schema-sha256",
      hash(readFileSync(join(this.root, "upgraded.db"))),
    ];
  }
  run(kind: string, args: string[] = []) {
    const argv = [
      "--json",
      "--root",
      this.root,
      "--class",
      kind,
      "--contract",
      "contract.json",
      "--inventory",
      "inventory.json",
      "--inventory-sha256",
      hash(readFileSync(join(this.root, "inventory.json"))),
      "--knip",
      knip,
      "--knip-sha256",
      hash(readFileSync(knip)),
      ...args,
    ];
    const result = Bun.spawnSync([process.execPath, cli, ...argv], {
      cwd: this.root,
      timeout: 30_000,
    });
    const lines: string[] = [];
    const log = console.log;
    try {
      console.log = (line: string) => {
        lines.push(line);
      };
      expect(censusMain(argv)).toBe(result.exitCode);
      expect(`${lines.join("\n")}\n`).toBe(result.stdout.toString());
    } finally {
      console.log = log;
    }
    return {
      code: result.exitCode,
      output: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }
  [Symbol.dispose](): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
export const protocol = `export namespace BusEvent {
  export interface Descriptor { name: string; schema: object }
  export function define(name: string, schema: object): Descriptor { return { name, schema }; }
}
export const Ready = BusEvent.define("ready", {});`;
export const adapter = `import { Database } from "bun:sqlite";
const db = new Database(":memory:"); db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY)");
export function read() { return db.query("SELECT * FROM item").all(); }
export function write() { return db.query("INSERT INTO item VALUES (1)").run(); }`;

export function assertStoreWrite(fixture: Fixture): void {
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"productionWrites":[{');
}

export function configureElectronFixture(fixture: Fixture, html: string): void {
  fixture.write("package.json", JSON.stringify({ name: "fixture" }));
  fixture.write(
    "src/package.json",
    JSON.stringify({ name: "application", scripts: { build: "electron-vite build" } }),
  );
  fixture.write("src/index.html", html);
}

export function assertPublication(fixture: Fixture, published: boolean): void {
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe(published ? '["ready"]' : "[]");
  expect(fixture.run("publisher").code).toBe(published ? 0 : 1);
}
