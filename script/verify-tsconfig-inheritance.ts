/**
 * Shared tsconfig-base inheritance verifier (#501).
 *
 * Every TypeScript project in the workspace must extend the root
 * `tsconfig.base.json` (directly or through its package `tsconfig.json`), and
 * inheritance must not drift the effective configuration:
 *
 * - base + chain must resolve (a missing extends target fails closed),
 * - the issue-named emit constraints hold — protocol keeps declaration
 *   emission (and stays non-composite, reference-free), llm stays no-emit,
 * - no intended input silently leaves compilation: every source file under
 *   the claimed source roots belongs to at least one project,
 * - the protocol build project derives one `.d.ts` per input, and when
 *   `dist/` exists the emitted declaration set matches exactly.
 *
 * `packages/openomni/bench` and `packages/session/bench` are intentionally
 * absent from the source roots: no tsconfig project claimed them before the
 * shared base existed, and changing compilation membership is a #501 non-goal.
 *
 * Modes:
 *   bun run script/verify-tsconfig-inheritance.ts                     verify the repo
 *   bun run script/verify-tsconfig-inheritance.ts --json              machine-readable result
 *   bun run script/verify-tsconfig-inheritance.ts --fixture <path>    verify a fixture manifest
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

export type ProblemCode =
  | "missing_base_config"
  | "not_extending_base"
  | "config_parse_error"
  | "emit_policy_drift"
  | "missing_source_root"
  | "omitted_input"
  | "declaration_output_drift";

export interface Problem {
  readonly code: ProblemCode;
  readonly message: string;
}

export interface EmitExpectation {
  readonly declaration?: boolean;
  readonly noEmit?: boolean;
  readonly forbidComposite?: boolean;
  readonly forbidProjectReferences?: boolean;
}

export interface Manifest {
  /** Absolute path to the tree the manifest describes. */
  readonly root: string;
  /** Shared base config, relative to root. */
  readonly base: string;
  /** Project configs, relative to root; each must extend the base. */
  readonly projects: readonly string[];
  /** Per-project emit constraints (key = entry of `projects`). */
  readonly emitPolicy?: Readonly<Record<string, EmitExpectation>>;
  /** Directories whose .ts/.tsx files must all belong to some project. */
  readonly sourceRoots?: readonly string[];
  /** Project whose every input must derive a declaration output. */
  readonly declarationProject?: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly code: ProblemCode | null;
  readonly problems: readonly Problem[];
  readonly projectCount: number;
  readonly claimedFileCount: number;
}

const parseHost: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  onUnRecoverableConfigFileDiagnostic: () => {
    // Diagnostics are collected from parsed.errors below.
  },
};

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

/** Resolve a relative `extends` reference the way tsc does (± `.json`). */
function resolveExtendsRef(fromConfigPath: string, ref: string): string | null {
  const candidate = resolve(dirname(fromConfigPath), ref);
  if (existsSync(candidate)) return candidate;
  if (existsSync(`${candidate}.json`)) return `${candidate}.json`;
  return null;
}

interface ChainResult {
  readonly chain: readonly string[];
  readonly problem: Problem | null;
}

/** Walk the raw extends chain of one config without resolving options. */
export function extendsChainOf(configPath: string, projectLabel: string): ChainResult {
  const chain: string[] = [];
  let current = configPath;
  const seen = new Set<string>([current]);
  for (;;) {
    const read = ts.readConfigFile(current, ts.sys.readFile);
    if (read.error) {
      return {
        chain,
        problem: {
          code: "config_parse_error",
          message: `${projectLabel}: cannot read ${current}: ${formatDiagnostic(read.error)}`,
        },
      };
    }
    const extendsValue = (read.config as { extends?: unknown }).extends;
    if (extendsValue === undefined) return { chain, problem: null };
    if (typeof extendsValue !== "string" || !extendsValue.startsWith(".")) {
      return {
        chain,
        problem: {
          code: "config_parse_error",
          message: `${projectLabel}: unsupported extends value ${JSON.stringify(extendsValue)} in ${current} — this workspace uses single relative extends references only`,
        },
      };
    }
    const target = resolveExtendsRef(current, extendsValue);
    if (target === null) {
      return {
        chain,
        problem: {
          code: "missing_base_config",
          message: `${projectLabel}: extends target "${extendsValue}" of ${current} does not exist`,
        },
      };
    }
    if (seen.has(target)) {
      return {
        chain,
        problem: {
          code: "config_parse_error",
          message: `${projectLabel}: circular extends chain through ${target}`,
        },
      };
    }
    seen.add(target);
    chain.push(target);
    current = target;
  }
}

function parseProject(configPath: string, projectLabel: string): ts.ParsedCommandLine | Problem {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, parseHost);
  if (!parsed) {
    return { code: "config_parse_error", message: `${projectLabel}: config did not parse` };
  }
  const errors = parsed.errors.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const rendered = errors.map(formatDiagnostic).join("; ");
    return { code: "config_parse_error", message: `${projectLabel}: ${rendered}` };
  }
  return parsed;
}

function checkEmitPolicy(
  projectLabel: string,
  parsed: ts.ParsedCommandLine,
  expectation: EmitExpectation,
): Problem[] {
  const problems: Problem[] = [];
  const drift = (message: string): void => {
    problems.push({ code: "emit_policy_drift", message: `${projectLabel}: ${message}` });
  };
  const actualDeclaration = parsed.options.declaration === true;
  if (expectation.declaration !== undefined && actualDeclaration !== expectation.declaration) {
    drift(`declaration resolved to ${actualDeclaration}, expected ${expectation.declaration}`);
  }
  const actualNoEmit = parsed.options.noEmit === true;
  if (expectation.noEmit !== undefined && actualNoEmit !== expectation.noEmit) {
    drift(`noEmit resolved to ${actualNoEmit}, expected ${expectation.noEmit}`);
  }
  if (expectation.forbidComposite && parsed.options.composite !== undefined) {
    drift(`composite resolved to ${parsed.options.composite}, expected it unset`);
  }
  if (expectation.forbidProjectReferences && (parsed.projectReferences?.length ?? 0) > 0) {
    drift(`${parsed.projectReferences?.length} project reference(s) resolved, expected none`);
  }
  return problems;
}

const SKIP_SEGMENTS = new Set(["node_modules", "dist", "coverage"]);

function listSourceFiles(rootDir: string): string[] {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const match of glob.scanSync({ cwd: rootDir, onlyFiles: true })) {
    if (match.split("/").some((segment) => SKIP_SEGMENTS.has(segment))) continue;
    files.push(resolve(rootDir, match));
  }
  return files.sort();
}

function checkSourceCoverage(manifest: Manifest, claimed: ReadonlySet<string>): Problem[] {
  const problems: Problem[] = [];
  const orphans: string[] = [];
  for (const sourceRoot of manifest.sourceRoots ?? []) {
    const rootDir = resolve(manifest.root, sourceRoot);
    if (!existsSync(rootDir)) {
      problems.push({
        code: "missing_source_root",
        message: `source root ${sourceRoot} does not exist under ${manifest.root}`,
      });
      continue;
    }
    for (const file of listSourceFiles(rootDir)) {
      if (!claimed.has(file)) orphans.push(file);
    }
  }
  if (orphans.length > 0) {
    const shown = orphans.slice(0, 20).join(", ");
    const suffix = orphans.length > 20 ? ` (+${orphans.length - 20} more)` : "";
    problems.push({
      code: "omitted_input",
      message: `${orphans.length} source file(s) belong to no tsconfig project: ${shown}${suffix}`,
    });
  }
  return problems;
}

function checkDeclarationOutputs(manifest: Manifest, projectLabel: string): Problem[] {
  const configPath = resolve(manifest.root, projectLabel);
  const parsed = parseProject(configPath, projectLabel);
  if (!("options" in parsed)) return [parsed];
  const problems: Problem[] = [];
  const expected = new Set<string>();
  for (const input of parsed.fileNames) {
    if (input.endsWith(".d.ts")) continue;
    const declarations = ts
      .getOutputFileNames(parsed, input, !ts.sys.useCaseSensitiveFileNames)
      .filter((output) => output.endsWith(".d.ts"));
    if (declarations.length === 0) {
      problems.push({
        code: "declaration_output_drift",
        message: `${projectLabel}: input ${input} derives no .d.ts output`,
      });
      continue;
    }
    for (const declaration of declarations) expected.add(resolve(declaration));
  }
  const outDir = parsed.options.outDir;
  if (outDir !== undefined && existsSync(outDir)) {
    const actual = new Set(
      [...new Bun.Glob("**/*.d.ts").scanSync({ cwd: outDir, onlyFiles: true })].map((match) =>
        resolve(outDir, match),
      ),
    );
    for (const declaration of expected) {
      if (!actual.has(declaration)) {
        problems.push({
          code: "declaration_output_drift",
          message: `${projectLabel}: built output is missing declaration ${declaration}`,
        });
      }
    }
    for (const declaration of actual) {
      if (!expected.has(declaration)) {
        problems.push({
          code: "declaration_output_drift",
          message: `${projectLabel}: built output has unexpected declaration ${declaration}`,
        });
      }
    }
  }
  return problems;
}

export function verifyManifest(manifest: Manifest): VerifyResult {
  const problems: Problem[] = [];
  const claimed = new Set<string>();
  let projectCount = 0;

  const basePath = resolve(manifest.root, manifest.base);
  if (!existsSync(basePath)) {
    problems.push({
      code: "missing_base_config",
      message: `shared base ${manifest.base} does not exist under ${manifest.root}`,
    });
  } else {
    for (const project of manifest.projects) {
      projectCount += 1;
      const configPath = resolve(manifest.root, project);
      if (!existsSync(configPath)) {
        problems.push({
          code: "config_parse_error",
          message: `${project}: config does not exist`,
        });
        continue;
      }
      const { chain, problem } = extendsChainOf(configPath, project);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (!chain.includes(basePath)) {
        problems.push({
          code: "not_extending_base",
          message: `${project}: extends chain never reaches ${manifest.base}`,
        });
        continue;
      }
      const parsed = parseProject(configPath, project);
      if (!("options" in parsed)) {
        problems.push(parsed);
        continue;
      }
      for (const file of parsed.fileNames) claimed.add(resolve(file));
      const expectation = manifest.emitPolicy?.[project];
      if (expectation) problems.push(...checkEmitPolicy(project, parsed, expectation));
    }

    problems.push(...checkSourceCoverage(manifest, claimed));

    if (manifest.declarationProject !== undefined && problems.length === 0) {
      problems.push(...checkDeclarationOutputs(manifest, manifest.declarationProject));
    }
  }

  return {
    ok: problems.length === 0,
    code: problems[0]?.code ?? null,
    problems,
    projectCount,
    claimedFileCount: claimed.size,
  };
}

const repoRoot = join(import.meta.dir, "..");

/** Discover every workspace tsconfig project (fixture trees excluded). */
export function discoverRepoProjects(): string[] {
  const glob = new Bun.Glob("{apps,packages,script}/**/tsconfig*.json");
  const projects: string[] = [];
  for (const match of glob.scanSync({ cwd: repoRoot, onlyFiles: true })) {
    if (match.split("/").some((segment) => SKIP_SEGMENTS.has(segment))) continue;
    if (match.startsWith("script/fixtures/")) continue;
    projects.push(match);
  }
  return projects.sort();
}

export function repoManifest(): Manifest {
  return {
    root: repoRoot,
    base: "tsconfig.base.json",
    projects: discoverRepoProjects(),
    emitPolicy: {
      // #501 preservation constraints: protocol keeps declaration emission
      // (non-composite, reference-free per the captured baseline), llm stays
      // no-emit.
      "packages/protocol/tsconfig.json": {
        declaration: true,
        noEmit: false,
        forbidComposite: true,
        forbidProjectReferences: true,
      },
      "packages/protocol/tsconfig.build.json": {
        declaration: true,
        noEmit: false,
        forbidComposite: true,
        forbidProjectReferences: true,
      },
      "packages/llm/tsconfig.json": { noEmit: true },
      "packages/llm/tsconfig.test.json": { noEmit: true },
    },
    sourceRoots: [
      "apps/server/src",
      "apps/server/test",
      "packages/agent/bench",
      "packages/agent/src",
      "packages/agent/test",
      "packages/channels/src",
      "packages/channels/test",
      "packages/coordinator/src",
      "packages/coordinator/test",
      "packages/ipc/src",
      "packages/ipc/test",
      "packages/llm/src",
      "packages/llm/test",
      "packages/openomni/src",
      "packages/openomni/test",
      "packages/policy/src",
      "packages/policy/test",
      "packages/protocol/src",
      "packages/protocol/test",
      "packages/session/src",
      "packages/session/test",
      "packages/telemetry/src",
      "packages/telemetry/test",
      "script",
    ],
    declarationProject: "packages/protocol/tsconfig.build.json",
  };
}

export function loadFixtureManifest(manifestPath: string): Manifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Omit<Manifest, "root"> & {
    root: string;
  };
  return { ...raw, root: resolve(dirname(manifestPath), raw.root) };
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const fixtureIndex = args.indexOf("--fixture");
  const fixturePath = fixtureIndex >= 0 ? args[fixtureIndex + 1] : undefined;
  if (fixtureIndex >= 0 && fixturePath === undefined) {
    console.error("--fixture requires a manifest path");
    process.exit(2);
  }

  const manifest =
    fixturePath === undefined ? repoManifest() : loadFixtureManifest(resolve(fixturePath));
  const result = verifyManifest(manifest);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `OK: tsconfig inheritance — ${result.projectCount} project(s) extend ${manifest.base}, ${result.claimedFileCount} claimed input file(s), emit policy and declaration outputs intact`,
    );
  } else {
    for (const problem of result.problems) {
      console.error(`${problem.code}: ${problem.message}`);
    }
    console.error(`\n${result.problems.length} tsconfig inheritance problem(s) found`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) {
  main();
}
