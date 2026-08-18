import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

// #501 preservation constraints, pinned as tests: protocol keeps declaration
// emission (non-composite, reference-free, exactly the captured baseline) and
// the published module surface stays the declaration-backed dist barrel.

const packageRoot = resolve(import.meta.dir, "..");

function parseProject(configName: string): ts.ParsedCommandLine {
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(join(packageRoot, configName), {}, host);
  if (!parsed) {
    throw new Error(`${configName} did not parse`);
  }
  const errors = parsed.errors.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
        .join("; "),
    );
  }
  return parsed;
}

describe("protocol module surface", () => {
  test("package entry points at the declaration-backed dist barrel", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      main?: string;
      types?: string;
      exports?: Record<string, { import?: string; types?: string }>;
    };
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.exports?.["."]?.import).toBe("./dist/index.js");
    expect(manifest.exports?.["."]?.types).toBe("./dist/index.d.ts");
  });

  test("resolved configs preserve declaration emission without composite/reference drift", () => {
    for (const configName of ["tsconfig.json", "tsconfig.build.json"]) {
      const parsed = parseProject(configName);
      expect(parsed.options.declaration).toBe(true);
      expect(parsed.options.noEmit ?? false).toBe(false);
      expect(parsed.options.composite).toBeUndefined();
      expect(parsed.projectReferences ?? []).toHaveLength(0);
      expect(parsed.options.outDir).toBe(join(packageRoot, "dist"));
      expect(parsed.options.rootDir).toBe(join(packageRoot, "src"));
    }
  });

  test("build project compiles the barrel plus src modules only, tests excluded", () => {
    const parsed = parseProject("tsconfig.build.json");
    const files = parsed.fileNames.map((file) => resolve(file));
    expect(files).toContain(join(packageRoot, "src", "index.ts"));
    const srcPrefix = `${join(packageRoot, "src")}/`;
    for (const file of files) {
      expect(file.startsWith(srcPrefix)).toBe(true);
      expect(file.endsWith(".test.ts")).toBe(false);
    }
  });

  test("built dist carries a declaration for every build input (when dist exists)", () => {
    const distDir = join(packageRoot, "dist");
    if (!existsSync(distDir)) {
      // Pre-build tree (e.g. clean worktree before `bun run build`) — the
      // derivation-only check lives in script/verify-tsconfig-inheritance.ts.
      return;
    }
    const parsed = parseProject("tsconfig.build.json");
    for (const input of parsed.fileNames) {
      if (input.endsWith(".d.ts")) continue;
      const declarations = ts
        .getOutputFileNames(parsed, input, !ts.sys.useCaseSensitiveFileNames)
        .filter((output) => output.endsWith(".d.ts"));
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(existsSync(declaration)).toBe(true);
      }
    }
  });
});
