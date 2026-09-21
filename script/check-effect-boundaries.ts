import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");
const allowlistPath = "script/conformance/effect-runner-sites.json";
const runtimePackages = new Set(["agent", "llm", "ipc", "machines", "channels", "ledger"]);
const runnerNames = new Set(["runPromise", "runSync", "runFork", "ManagedRuntime"]);

type Violation = {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
};

type DeclaredFunction = {
  readonly exportedName: string;
  readonly node: ts.FunctionLikeDeclaration;
  readonly returnType: ts.TypeNode | undefined;
  readonly line: number;
};

type RunnerSite = {
  readonly file: string;
  readonly line: number;
  readonly key: string;
};

type CheckResult = {
  readonly violations: Violation[];
  readonly runnerSites: RunnerSite[];
};

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

function isEffectSpecifier(specifier: string): boolean {
  return specifier.startsWith("effect") || specifier.startsWith("@effect/");
}

function isTestFile(path: string): boolean {
  return /(^|\/)(test|__tests__|tests)\/|\.(test|spec)\.[cm]?tsx?$/.test(path);
}

function isScopedSource(path: string): boolean {
  if (!/\.[cm]?tsx?$/.test(path) || isTestFile(path)) return false;
  if (path.includes("/node_modules/") || path.includes("/dist/")) return false;
  return /^packages\/[^/]+\/src\//.test(path) || /^apps\/[^/]+\/src\//.test(path) || path.startsWith("script/");
}

function trackedSourceFiles(worktree: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
  return result.stdout
    .toString()
    .split("\0")
    .filter(isScopedSource)
    .sort();
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind.ExportKeyword): boolean {
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function declaredFunctions(source: ts.SourceFile): DeclaredFunction[] {
  const declarations = new Map<string, Omit<DeclaredFunction, "exportedName">>();
  const exported = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      const name = statement.name.text;
      declarations.set(name, {
        node: statement,
        returnType: statement.type,
        line: source.getLineAndCharacterOfPosition(statement.name.getStart(source)).line + 1,
      });
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exported.set(name, name);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer;
        if (initializer === undefined || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) continue;
        const name = declaration.name.text;
        declarations.set(name, {
          node: initializer,
          returnType: initializer.type,
          line: source.getLineAndCharacterOfPosition(declaration.name.getStart(source)).line + 1,
        });
        if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exported.set(name, name);
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exported.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  return [...exported].flatMap(([exportedName, localName]) => {
    const declaration = declarations.get(localName);
    return declaration === undefined ? [] : [{ exportedName, ...declaration }];
  });
}

function entityNameText(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : `${entityNameText(name.left)}.${name.right.text}`;
}

function isPromiseReturn(type: ts.TypeNode | undefined): boolean {
  return type !== undefined && ts.isTypeReferenceNode(type) && entityNameText(type.typeName) === "Promise";
}

function isEffectReturn(type: ts.TypeNode | undefined, effectNamespaces: ReadonlySet<string>): boolean {
  if (type === undefined || !ts.isTypeReferenceNode(type)) return false;
  const name = entityNameText(type.typeName);
  if (name === "Effect.Effect") return true;
  const [namespace, member] = name.split(".");
  return namespace !== undefined && member === "Effect" && effectNamespaces.has(namespace);
}

function promiseBaseName(name: string): string | undefined {
  if (name.endsWith("Promise")) return name.slice(0, -"Promise".length);
  if (name.endsWith("Async")) return name.slice(0, -"Async".length);
  return undefined;
}

function add(violations: Violation[], file: string, line: number, rule: string): void {
  violations.push({ file, line, rule });
}

function importSpecifier(statement: ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration): string | undefined {
  if (ts.isImportEqualsDeclaration(statement)) {
    return ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)
      ? statement.moduleReference.expression.text
      : undefined;
  }
  return statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : undefined;
}

function isR1Target(path: string): boolean {
  return /^packages\/(protocol|ui)\/src\//.test(path) || path.startsWith("apps/desktop/src/") || path.startsWith("apps/openomni/src/tools/");
}

function runtimePackage(path: string): boolean {
  const match = /^packages\/([^/]+)\/src\//.exec(path);
  return match !== null && runtimePackages.has(match[1] ?? "");
}

function runnerSite(path: string, line: number, exportedFunction: string | undefined): RunnerSite {
  return { file: path, line, key: `${path}:${exportedFunction ?? line}` };
}

function checkFile(worktree: string, path: string): CheckResult {
  const absolute = join(worktree, path);
  if (!existsSync(absolute)) return { violations: [], runnerSites: [] };
  const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.ESNext, true);
  const violations: Violation[] = [];
  const runnerSites: RunnerSite[] = [];
  const effectNamespaces = new Set<string>(["Effect"]);
  const runnerNamespaces = new Set<string>();
  const functions = declaredFunctions(source);
  const exportedFunctionNames = new Map<ts.Node, string>();
  for (const entry of functions) exportedFunctionNames.set(entry.node, entry.exportedName);

  const recordRunner = (line: number, exportedFunction: string | undefined): void => {
    if (runtimePackage(path)) {
      runnerSites.push(runnerSite(path, line, exportedFunction));
    } else if (!path.startsWith("apps/openomni/src/")) {
      add(violations, path, line, "R2 Effect runner");
    }
  };

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement)) continue;
    const specifier = importSpecifier(statement);
    if (specifier === undefined || !isEffectSpecifier(specifier)) continue;
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    if (isR1Target(path)) add(violations, path, line, "R1 effect import");
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
      runnerNamespaces.add(clause.namedBindings.name.text);
      effectNamespaces.add(clause.namedBindings.name.text);
    }
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const imported of clause.namedBindings.elements) {
        const importedName = imported.propertyName?.text ?? imported.name.text;
        if (importedName === "Effect") {
          effectNamespaces.add(imported.name.text);
          runnerNamespaces.add(imported.name.text);
        }
        if (runnerNames.has(importedName)) recordRunner(line, undefined);
      }
    }
  }

  if (runtimePackage(path)) {
    const effectNames = new Set(
      functions.filter((entry) => isEffectReturn(entry.returnType, effectNamespaces)).map((entry) => entry.exportedName),
    );
    for (const entry of functions) {
      const baseName = promiseBaseName(entry.exportedName);
      if (baseName !== undefined && isPromiseReturn(entry.returnType) && effectNames.has(baseName))
        add(violations, path, entry.line, "R2 Promise twin");
    }
  }

  const visit = (node: ts.Node, exportedFunction: string | undefined): void => {
    const enclosingFunction = exportedFunctionNames.get(node) ?? exportedFunction;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && runnerNamespaces.has(node.expression.text) && runnerNames.has(node.name.text)) {
      const line = source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1;
      recordRunner(line, enclosingFunction);
    }
    ts.forEachChild(node, (child) => visit(child, enclosingFunction));
  };
  ts.forEachChild(source, (node) => visit(node, undefined));

  return { violations, runnerSites };
}

function parseAllowlist(worktree: string): { readonly entries: string[]; readonly violations: Violation[] } {
  const path = join(worktree, allowlistPath);
  if (!existsSync(path)) return { entries: [], violations: [{ file: allowlistPath, line: 1, rule: "R2 missing Effect runner allowlist" }] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string"))
      return { entries: [], violations: [{ file: allowlistPath, line: 1, rule: "R2 invalid Effect runner allowlist" }] };
    const entries = [...parsed];
    if (new Set(entries).size !== entries.length || entries.some((entry) => !/^packages\/[^/]+\/src\/.*:[^:]+$/.test(entry)))
      return { entries: [], violations: [{ file: allowlistPath, line: 1, rule: "R2 invalid Effect runner allowlist" }] };
    return { entries, violations: [] };
  } catch {
    return { entries: [], violations: [{ file: allowlistPath, line: 1, rule: "R2 invalid Effect runner allowlist" }] };
  }
}

function staleEntryLocation(worktree: string, entry: string): Pick<Violation, "file" | "line"> {
  const separator = entry.lastIndexOf(":");
  const file = entry.slice(0, separator);
  const target = entry.slice(separator + 1);
  if (/^\d+$/.test(target)) return { file, line: Number(target) };
  const path = join(worktree, file);
  if (!existsSync(path)) return { file, line: 1 };
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true);
  return { file, line: declaredFunctions(source).find((entry) => entry.exportedName === target)?.line ?? 1 };
}

function checkEffectBoundaryResult(worktree: string, update: boolean): CheckResult {
  const results = trackedSourceFiles(worktree).map((path) => checkFile(worktree, path));
  const runnerSites = results.flatMap((result) => result.runnerSites);
  const currentEntries = [...new Set(runnerSites.map((site) => site.key))].sort();
  if (update) writeFileSync(join(worktree, allowlistPath), `${JSON.stringify(currentEntries, null, 2)}\n`);
  const allowlist = update ? { entries: currentEntries, violations: [] } : parseAllowlist(worktree);
  const violations = [...results.flatMap((result) => result.violations), ...allowlist.violations];
  const allowed = new Set(allowlist.entries);
  for (const site of runnerSites) {
    if (!allowed.has(site.key)) add(violations, site.file, site.line, "R2 Effect runner");
  }
  for (const entry of allowlist.entries) {
    if (!currentEntries.includes(entry)) {
      const location = staleEntryLocation(worktree, entry);
      add(violations, location.file, location.line, "R2 stale Effect runner allowlist");
    }
  }
  return { violations, runnerSites };
}

export function checkEffectBoundaries(worktree = root): string[] {
  const violations = checkEffectBoundaryResult(worktree, false).violations;
  const distinct = new Map<string, Violation>();
  for (const violation of violations) distinct.set(`${violation.file}:${violation.line} ${violation.rule}`, violation);
  return [...distinct.values()]
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule))
    .map((violation) => `${normalized(relative(worktree, join(worktree, violation.file)))}:${violation.line} ${violation.rule}`);
}

export function main(argv = Bun.argv.slice(2)): number {
  const rootIndex = argv.indexOf("--root");
  const worktree = rootIndex === -1 ? root : argv[rootIndex + 1];
  if (worktree === undefined) throw new Error("--root requires a directory");
  const update = argv.includes("--update");
  const result = checkEffectBoundaryResult(worktree, update);
  if (update) {
    const entries = [...new Set(result.runnerSites.map((site) => site.key))].sort();
    console.log(`wrote ${allowlistPath}`);
    console.log(JSON.stringify(entries, null, 2));
  }
  const distinct = new Map<string, Violation>();
  for (const violation of result.violations) distinct.set(`${violation.file}:${violation.line} ${violation.rule}`, violation);
  const violations = [...distinct.values()]
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule))
    .map((violation) => `${normalized(relative(worktree, join(worktree, violation.file)))}:${violation.line} ${violation.rule}`);
  for (const violation of violations) console.log(violation);
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
