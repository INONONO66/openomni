import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { decodeJson, type Json } from "./quality-json";

const root = join(import.meta.dir, "..");
const allowlistPath = "script/conformance/effect-runner-sites.json";
const approvedEdges = new Set(["apps/openomni/src/cli/main.ts", "apps/openomni/src/gateway.ts"]);
const runnerNames = new Set(["runPromise", "runPromiseExit", "runSync", "runSyncExit", "runFork", "runCallback"]);

export type BoundaryFinding = {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly failing: boolean;
};
type Origin = { readonly module: string; readonly members: readonly string[] };
type DeclaredFunction = { readonly exportedName: string; readonly node: ts.FunctionLikeDeclaration; readonly line: number };
type RunnerSite = { readonly file: string; readonly line: number; readonly key: string };
type Analysis = { readonly findings: BoundaryFinding[]; readonly sites: RunnerSite[] };

function finding(code: string, file: string, line = 1): BoundaryFinding {
  return { code, file, line, failing: code !== "R2_ALLOWLISTED_RATCHET" };
}
function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}
function isEffectSpecifier(value: string): boolean {
  return value === "effect" || value.startsWith("effect/") || value.startsWith("@effect/");
}
function excludedSurface(file: string): boolean {
  return /^packages\/(protocol|ui)\/src\//.test(file) || file.startsWith("apps/desktop/src/") || file.startsWith("apps/openomni/src/tools/");
}
function sourcePath(file: string): boolean {
  return /^(apps|packages|script)\//.test(file) && /\.[cm]?tsx?$/.test(file) && !/(^|\/)(node_modules|dist|coverage|\.turbo|generated)\//.test(file);
}
function repositoryFiles(worktree: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return [...new Set(result.stdout.toString().split("\0").filter((file) => file && existsSync(join(worktree, file))))].sort();
}
function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}
function localFunctions(statement: ts.Statement): readonly [string, ts.FunctionLikeDeclaration][] {
  if (ts.isFunctionDeclaration(statement) && statement.name) return [[statement.name.text, statement]];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration): [string, ts.FunctionLikeDeclaration][] => {
    const value = declaration.initializer;
    return ts.isIdentifier(declaration.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? [[declaration.name.text, value]] : [];
  });
}
function declaredFunctions(source: ts.SourceFile): DeclaredFunction[] {
  const declarations = new Map<string, ts.FunctionLikeDeclaration>();
  const names = new Map<string, string>();
  for (const statement of source.statements) {
    for (const [name, node] of localFunctions(statement)) {
      declarations.set(name, node);
      if (exported(statement)) names.set(name, name);
    }
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const entry of statement.exportClause.elements) names.set(entry.name.text, entry.propertyName?.text ?? entry.name.text);
  }
  return [...names].flatMap(([exportedName, local]) => {
    const node = declarations.get(local);
    return node ? [{ exportedName, node, line: lineOf(node) }] : [];
  });
}

/** Bind lexical identities with TypeScript; resolve provenance without requiring external declarations. */
class Provenance {
  private readonly checker: ts.TypeChecker;
  private readonly sources: ReadonlyMap<string, ts.SourceFile>;
  constructor(program: ts.Program) {
    this.checker = program.getTypeChecker();
    this.sources = new Map(program.getSourceFiles().map((source) => [resolve(source.fileName), source]));
  }
  private module(specifier: string, source: ts.SourceFile): Origin | undefined {
    if (isEffectSpecifier(specifier)) return { module: specifier, members: [] };
    const base = resolve(dirname(source.fileName), specifier).replace(/\.[cm]?jsx?$/, "");
    const candidates = [base, ...[".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"].map((suffix) => base + suffix)];
    const file = candidates.find((candidate) => this.sources.has(candidate));
    return file ? { module: file, members: [] } : undefined;
  }
  private fromSpecifier(node: ts.Expression | undefined, source: ts.SourceFile): Origin | undefined {
    return node && ts.isStringLiteral(node) ? this.module(node.text, source) : undefined;
  }
  member(origin: Origin | undefined, name: string, seen = new Set<ts.Node | string>()): Origin | undefined {
    if (!origin) return undefined;
    if (isEffectSpecifier(origin.module)) return { module: origin.module, members: [...origin.members, name] };
    const key = `${origin.module}:${name}`;
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    const source = this.sources.get(origin.module);
    if (!source) return undefined;
    for (const statement of source.statements) {
      const result = this.exportedMember(statement, name, next);
      if (result) return result;
    }
    return undefined;
  }
  private exportedMember(statement: ts.Statement, name: string, seen: Set<ts.Node | string>): Origin | undefined {
    if (ts.isExportDeclaration(statement)) return this.exportDeclaration(statement, name, seen);
    if (!exported(statement) || !ts.isVariableStatement(statement)) return undefined;
    const declaration = statement.declarationList.declarations.find((entry) => ts.isIdentifier(entry.name) && entry.name.text === name);
    return declaration?.initializer ? this.expression(declaration.initializer, seen) : undefined;
  }
  private exportDeclaration(node: ts.ExportDeclaration, name: string, seen: Set<ts.Node | string>): Origin | undefined {
    if (node.isTypeOnly) return undefined;
    const origin = this.fromSpecifier(node.moduleSpecifier, node.getSourceFile());
    const clause = node.exportClause;
    if (!clause) return this.member(origin, name, seen);
    if (ts.isNamespaceExport(clause)) return clause.name.text === name ? origin : undefined;
    const entry = clause.elements.find((element) => element.name.text === name && !element.isTypeOnly);
    if (!entry) return undefined;
    const local = entry.propertyName ?? entry.name;
    if (origin) return this.member(origin, local.text, seen);
    const symbol = this.checker.getExportSpecifierLocalTargetSymbol(entry);
    return this.declarations(symbol?.declarations, seen);
  }
  private declarations(nodes: readonly ts.Declaration[] | undefined, seen: Set<ts.Node | string>): Origin | undefined {
    for (const node of nodes ?? []) {
      if (seen.has(node)) continue;
      const result = this.declaration(node, new Set(seen).add(node));
      if (result) return result;
    }
    return undefined;
  }
  private declaration(node: ts.Declaration, seen: Set<ts.Node | string>): Origin | undefined {
    if (ts.isVariableDeclaration(node)) return node.initializer ? this.expression(node.initializer, seen) : undefined;
    if (ts.isNamespaceImport(node)) {
      const clause = node.parent;
      return clause.isTypeOnly ? undefined : this.fromSpecifier(clause.parent.moduleSpecifier, node.getSourceFile());
    }
    if (!ts.isImportSpecifier(node) || node.isTypeOnly || node.parent.parent.isTypeOnly) return undefined;
    const origin = this.fromSpecifier(node.parent.parent.parent.moduleSpecifier, node.getSourceFile());
    return this.member(origin, node.propertyName?.text ?? node.name.text, seen);
  }
  expression(node: ts.Node, seen = new Set<ts.Node | string>()): Origin | undefined {
    if (ts.isIdentifier(node)) return this.declarations(this.checker.getSymbolAtLocation(node)?.declarations, seen);
    if (ts.isPropertyAccessExpression(node)) return this.member(this.expression(node.expression, seen), node.name.text, seen);
    if (ts.isQualifiedName(node)) return this.member(this.expression(node.left, seen), node.right.text, seen);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return this.member(this.expression(node.expression, seen), node.argumentExpression.text, seen);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return this.expression(node.expression, seen);
    return undefined;
  }
}
function originPath(origin: Origin | undefined): string[] {
  return origin ? [...origin.module.split("/").slice(1), ...origin.members] : [];
}
function isRunner(origin: Origin | undefined): boolean {
  if (!origin || !isEffectSpecifier(origin.module)) return false;
  const path = originPath(origin);
  const method = path.at(-1) ?? "";
  const owner = path.at(-2);
  if (runnerNames.has(method)) return owner === undefined || owner === "Effect" || owner === "Runtime";
  return (owner === "ManagedRuntime" && method === "make") || (owner === "Layer" && method === "toRuntime");
}
function moduleSpecifier(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) return node.expression.text;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) return node.argument.literal.text;
  if (!ts.isCallExpression(node)) return undefined;
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
  const first = node.arguments[0];
  return (dynamic || required) && first && ts.isStringLiteral(first) ? first.text : undefined;
}
function importFindings(source: ts.SourceFile, file: string): BoundaryFinding[] {
  const result: BoundaryFinding[] = [];
  if (!excludedSurface(file)) return result;
  const code = file.startsWith("apps/openomni/src/tools/") ? "R1_TOOL_EFFECT_IMPORT" : "R1_EFFECT_IMPORT";
  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifier(node);
    if (specifier && isEffectSpecifier(specifier)) result.push(finding(code, file, lineOf(node)));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}
function nonExecutable(node: ts.Node): boolean {
  return ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node);
}
function valueReference(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return true;
  if (!ts.isIdentifier(node)) return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ("name" in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) return false;
  return true;
}
function runnerSites(source: ts.SourceFile, file: string, provenance: Provenance, functions: readonly DeclaredFunction[]): RunnerSite[] {
  const result: RunnerSite[] = [];
  if (approvedEdges.has(file)) return result;
  const names = new Map<ts.Node, string>(functions.map((entry) => [entry.node, entry.exportedName]));
  const visit = (node: ts.Node, enclosing?: string): void => {
    if (nonExecutable(node)) return;
    const name = names.get(node) ?? enclosing;
    if (valueReference(node) && isRunner(provenance.expression(node))) {
      const line = lineOf(ts.isPropertyAccessExpression(node) ? node.name : node);
      result.push({ file, line, key: `${file}:${name ?? line}` });
    }
    ts.forEachChild(node, (child) => visit(child, name));
  };
  visit(source);
  return result;
}

type FunctionShape = { readonly entry: DeclaredFunction; readonly effect: boolean; readonly promise: boolean; readonly wrapper: boolean; readonly value: string | undefined };
function returnedExpressions(node: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!node.body) return [];
  if (!ts.isBlock(node.body)) return [node.body];
  const results: ts.Expression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) && child.expression) results.push(child.expression);
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  return results;
}
function effectExpression(node: ts.Expression, provenance: Provenance): boolean {
  const origin = provenance.expression(ts.isCallExpression(node) ? node.expression : node);
  const path = originPath(origin);
  return !!origin && isEffectSpecifier(origin.module) && (path[0] === "Effect" || origin.module === "effect/Effect") && !isRunner(origin);
}
function promiseExpression(node: ts.Expression, provenance: Provenance): boolean {
  if (!ts.isCallExpression(node)) return false;
  const origin = provenance.expression(node.expression);
  return (isRunner(origin) && /runPromise/.test(originPath(origin).at(-1) ?? "")) || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Promise");
}
function functionShape(entry: DeclaredFunction, provenance: Provenance): FunctionShape {
  const type = entry.node.type;
  const reference = type && ts.isTypeReferenceNode(type) ? type : undefined;
  const typedEffect = reference && originPath(provenance.expression(reference.typeName)).at(-1) === "Effect";
  const typedPromise = reference?.typeName.getText() === "Promise";
  const returns = returnedExpressions(entry.node);
  const wrapper = returns.some((node) => ts.isCallExpression(node) && isRunner(provenance.expression(node.expression)) && /runPromise/.test(originPath(provenance.expression(node.expression)).at(-1) ?? ""));
  return {
    entry,
    effect: !!typedEffect || returns.some((node) => effectExpression(node, provenance)),
    promise: typedPromise || wrapper || !!ts.getModifiers(entry.node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || returns.some((node) => promiseExpression(node, provenance)),
    wrapper,
    value: reference?.typeArguments?.[0]?.getText().replace(/\s/g, ""),
  };
}
function promiseTwins(file: string, functions: readonly DeclaredFunction[], provenance: Provenance): BoundaryFinding[] {
  if (!/^packages\/[^/]+\/src\//.test(file)) return [];
  const shapes = functions.map((entry) => functionShape(entry, provenance));
  const effects = shapes.filter((shape) => shape.effect);
  return shapes.filter((shape) => {
    if (!shape.promise) return false;
    const base = shape.entry.exportedName.replace(/(Promise|Async)$/, "");
    return shape.wrapper || effects.some((effect) => effect.entry.exportedName === base || (shape.value !== undefined && shape.value === effect.value));
  }).map((shape) => finding("R3_PROMISE_TWIN", file, shape.entry.line));
}
function object(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function manifestFindings(worktree: string, files: readonly string[]): BoundaryFinding[] {
  const results: BoundaryFinding[] = [];
  for (const file of files.filter((path) => /(^|\/)package\.json$/.test(path) && !/(^|\/)(node_modules|dist)\//.test(path))) {
    const parsed = decodeJson(readFileSync(join(worktree, file), "utf8"));
    if (!object(parsed)) throw new Error(`Invalid manifest: ${file}`);
    const excluded = /^(packages\/(protocol|ui)|apps\/desktop)\/package\.json$/.test(file);
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const dependencies = parsed[key];
      if (dependencies === undefined) continue;
      if (!object(dependencies) || Object.values(dependencies).some((value) => typeof value !== "string")) throw new Error(`Invalid dependencies: ${file}`);
      if (excluded && Object.keys(dependencies).some(isEffectSpecifier)) results.push(finding("R1_EFFECT_DEPENDENCY", file));
    }
  }
  return results;
}
function validRatchetEntry(entry: string): boolean {
  const separator = entry.lastIndexOf(":");
  const file = entry.slice(0, separator);
  const target = entry.slice(separator + 1);
  const surface = /^(apps|packages)\/[^/]+\/(test|tests|__tests__|bench)\//.test(file) || /^script\/.*\.(test|spec)\.[cm]?tsx?$/.test(file);
  return surface && sourcePath(file) && !file.split("/").includes("..") && /^(?:[1-9]\d*|[A-Za-z_$][\w$]*)$/.test(target);
}
function readAllowlist(worktree: string): { readonly entries: readonly string[]; readonly findings: readonly BoundaryFinding[] } {
  const path = join(worktree, allowlistPath);
  if (!existsSync(path)) return { entries: [], findings: [finding("R2_MISSING_ALLOWLIST", allowlistPath)] };
  try {
    const parsed = decodeJson(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Expected an array");
    const entries = parsed.filter((entry): entry is string => typeof entry === "string");
    if (entries.length !== parsed.length || new Set(entries).size !== entries.length || !entries.every(validRatchetEntry)) throw new Error("Invalid ratchet entries");
    return { entries, findings: [] };
  } catch {
    return { entries: [], findings: [finding("R2_INVALID_ALLOWLIST", allowlistPath)] };
  }
}
function analyze(worktree: string, files: readonly string[]): Analysis {
  const program = ts.createProgram(files.filter(sourcePath).map((file) => join(worktree, file)), { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve, noResolve: true, noLib: true });
  const diagnostics = program.getSyntacticDiagnostics();
  if (diagnostics.length) return { sites: [], findings: diagnostics.map((diagnostic) => finding("ANALYSIS_ERROR", diagnostic.file ? relative(worktree, diagnostic.file.fileName) : "script", diagnostic.file ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1 : 1)) };
  const provenance = new Provenance(program);
  const result: Analysis = { findings: manifestFindings(worktree, files), sites: [] };
  for (const source of program.getSourceFiles()) {
    const file = relative(worktree, source.fileName).replaceAll("\\", "/");
    const functions = declaredFunctions(source);
    result.findings.push(...importFindings(source, file), ...promiseTwins(file, functions, provenance));
    result.sites.push(...runnerSites(source, file, provenance, functions));
  }
  return result;
}
function staleFinding(worktree: string, entry: string): BoundaryFinding {
  const separator = entry.lastIndexOf(":");
  const file = entry.slice(0, separator);
  const target = entry.slice(separator + 1);
  if (/^\d+$/.test(target)) return finding("R2_STALE_ALLOWLIST", file, Number(target));
  const path = join(worktree, file);
  const source = existsSync(path) ? ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true) : undefined;
  return finding("R2_STALE_ALLOWLIST", file, source ? declaredFunctions(source).find((entry) => entry.exportedName === target)?.line ?? 1 : 1);
}
export function checkEffectBoundaryFindings(worktree = root): readonly BoundaryFinding[] {
  const allowlist = readAllowlist(worktree);
  let result: Analysis;
  try {
    result = analyze(worktree, repositoryFiles(worktree));
  } catch {
    result = { sites: [], findings: [finding("ANALYSIS_ERROR", "script")] };
  }
  const findings = [...result.findings, ...allowlist.findings];
  const allowed = new Set(allowlist.entries);
  const live = new Set(result.sites.map((site) => site.key));
  for (const site of result.sites) findings.push(finding(allowed.has(site.key) ? "R2_ALLOWLISTED_RATCHET" : "R2_EFFECT_RUNNER", site.file, site.line));
  for (const entry of allowed) if (!live.has(entry)) findings.push(staleFinding(worktree, entry));
  const distinct = new Map(findings.map((entry) => [`${entry.code}:${entry.file}:${entry.line}`, entry]));
  return [...distinct.values()].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.code.localeCompare(right.code));
}
function formatFinding(entry: BoundaryFinding): string {
  return `${entry.file}:${entry.line} ${entry.code}${entry.failing ? "" : " allowlisted (ratchet)"}`;
}
export function checkEffectBoundaries(worktree = root): string[] {
  return checkEffectBoundaryFindings(worktree).map(formatFinding);
}
export function main(argv = Bun.argv.slice(2)): number {
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === "--root" && argv[1] && !argv[1].startsWith("--"))) {
    console.log(JSON.stringify({ code: "INVALID_ARGUMENTS", message: "Expected no arguments or --root <dir>" }));
    return 1;
  }
  const findings = checkEffectBoundaryFindings(resolve(argv[1] ?? root));
  for (const entry of findings) console.log(entry.code === "ANALYSIS_ERROR" ? JSON.stringify(entry) : formatFinding(entry));
  return findings.some((entry) => entry.failing) ? 1 : 0;
}
if (import.meta.main) process.exitCode = main();
