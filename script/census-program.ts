import { dirname, resolve } from "node:path";
import ts from "typescript";
import { InventoryError } from "./quality-inventory";

/** JSONC stays inside the compiler parser; no configuration programs or watchers. */
export function readProject(root: string, path: string): { fileNames: string[]; options: ts.CompilerOptions } {
  const configPath = resolve(root, path);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new InventoryError("config", path, "native configuration diagnostic");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), {}, configPath);
  if (parsed.errors.length || (!parsed.fileNames.length && !parsed.projectReferences?.length))
    throw new InventoryError("config", path, "native configuration diagnostic");
  return { fileNames: parsed.fileNames, options: parsed.options };
}

/** A run owns an immutable source snapshot. Compiler options remain project-local. */
export class CensusPrograms {
  readonly stats = { programs: 0, reused: 0, parses: new Map<string, number>() };
  private readonly host = ts.createCompilerHost({}, true);
  private readonly sources = new Map<string, ts.SourceFile>();
  private readonly programs = new Map<string, ts.Program>();
  private readonly registry = ts.createDocumentRegistry();
  private sourceOptions = "";
  private previous: ts.Program | undefined;

  constructor() {
    const getSourceFile = this.host.getSourceFile;
    this.host.getSourceFile = (fileName, languageVersion, onError) => {
      const path = resolve(fileName);
      const mode = typeof languageVersion === "object" ? languageVersion.impliedNodeFormat : undefined;
      const key = JSON.stringify([path, this.sourceOptions, mode]);
      const cached = this.sources.get(key);
      if (cached) return cached;
      const source = getSourceFile(fileName, languageVersion, onError);
      if (source) {
        this.sources.set(key, source);
        this.stats.parses.set(path, (this.stats.parses.get(path) ?? 0) + 1);
      }
      return source;
    };
  }

  program(fileNames: string[], options: ts.CompilerOptions): ts.Program {
    // Config location is provenance, not a semantic compiler option. Resolved
    // paths and every actual option participate, so differing projects stay separate.
    const entries = Object.entries(options).filter(([key]) => key !== "configFilePath" && key !== "configFile").sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify([[...new Set(fileNames.map((path) => resolve(path)))].sort(), entries]);
    const cached = this.programs.get(key);
    if (cached) {
      this.stats.reused++;
      return cached;
    }
    // TypeScript's own parse/bind option key prevents reuse of a global script
    // as a forced module (or an AST with another target/JSX grammar).
    this.sourceOptions = this.registry.getKeyForCompilationSettings(options);
    const program = ts.createProgram(fileNames, options, this.host, this.previous);
    this.previous = program;
    this.programs.set(key, program);
    this.stats.programs++;
    return program;
  }
}
