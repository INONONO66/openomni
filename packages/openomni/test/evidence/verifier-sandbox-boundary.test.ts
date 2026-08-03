/// <reference types="bun" />

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import ts from "typescript";

const allowedImports: Readonly<Record<string, ReadonlySet<string>>> = {
  "verifier-conformance-canonical.ts": new Set(["node:crypto", "node:util/types", "zod"]),
  "verifier-registry-contract.ts": new Set(["zod", "./verifier-conformance-canonical.js"]),
  "verifier-registry-core.ts": new Set([
    "./verifier-registry-contract.js",
    "./verifier-conformance-canonical.js",
    "./verifier-registry-evaluators.js",
  ]),
  "verifier-registry-evaluators.ts": new Set([
    "zod",
    "./verifier-registry-contract.js",
    "./verifier-frozen-nli-model.js",
    "./verifier-sandbox.js",
  ]),
  "verifier-sandbox.ts": new Set([
    "node:crypto",
    "@openomni/protocol",
    "zod",
    "./verifier-conformance-canonical.js",
    "./verifier-frozen-nli-model.js",
  ]),
  "verifier-frozen-nli-model.ts": new Set(["node:crypto"]),
  "verifier-registry.ts": new Set([
    "./verifier-registry-contract.js",
    "./verifier-registry-core.js",
    "./verifier-frozen-nli-model.js",
  ]),
};
const forbiddenGlobals = new Set([
  "Bun",
  "crypto",
  "Date",
  "EventSource",
  "Function",
  "global",
  "WebSocket",
  "Worker",
  "eval",
  "fetch",
  "globalThis",
  "Math",
  "navigator",
  "performance",
  "process",
  "require",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "self",
  "window",
]);
const boundaryRoots = ["verifier-registry.ts"];
const allowedExternalBindings: Readonly<Record<string, ReadonlySet<string>>> = {
  "node:crypto": new Set(["createHash"]),
  "node:util/types": new Set(["isProxy"]),
  "@openomni/protocol": new Set(["Tool"]),
  zod: new Set(["z"]),
};

describe("verifier sandbox structural boundary", () => {
  test("forbids ambient effect imports and globals in the verifier path", () => {
    const violations: string[] = [];
    for (const [file, parsed] of collectBoundaryGraph(violations)) {
      visit(parsed, file, violations);
    }
    expect(violations).toEqual([]);

    const hostile = ts.createSourceFile(
      "hostile.ts",
      'export { request } from "node:https"; export * from "node:child_process"; globalThis["fetch"]("https://example.test"); import("node:https"); require("node:net");',
      ts.ScriptTarget.Latest,
      true,
    );
    const hostileViolations: string[] = [];
    visit(hostile, "hostile.ts", hostileViolations);
    expect(hostileViolations).toEqual([
      "hostile.ts: unapproved module node:https",
      "hostile.ts: unapproved module node:child_process",
      "hostile.ts: forbidden global globalThis",
      "hostile.ts: dynamic import",
      "hostile.ts: forbidden global require",
    ]);
    const hostileBinding = ts.createSourceFile(
      "verifier-frozen-nli-model.ts",
      'import { randomBytes } from "node:crypto";',
      ts.ScriptTarget.Latest,
      true,
    );
    const bindingViolations: string[] = [];
    visit(hostileBinding, "verifier-frozen-nli-model.ts", bindingViolations);
    expect(bindingViolations).toEqual([
      "verifier-frozen-nli-model.ts: unapproved binding randomBytes from node:crypto",
    ]);
    const hostileReexport = ts.createSourceFile(
      "verifier-frozen-nli-model.ts",
      'export { randomBytes } from "node:crypto";',
      ts.ScriptTarget.Latest,
      true,
    );
    const reexportViolations: string[] = [];
    visit(hostileReexport, "verifier-frozen-nli-model.ts", reexportViolations);
    expect(reexportViolations).toEqual([
      "verifier-frozen-nli-model.ts: unapproved binding randomBytes from node:crypto",
    ]);
    const hostileAmbientCrypto = ts.createSourceFile(
      "verifier-frozen-nli-model.ts",
      "crypto.randomUUID(); crypto.getRandomValues(new Uint8Array(8));",
      ts.ScriptTarget.Latest,
      true,
    );
    const ambientCryptoViolations: string[] = [];
    visit(hostileAmbientCrypto, "verifier-frozen-nli-model.ts", ambientCryptoViolations);
    expect(ambientCryptoViolations).toEqual([
      "verifier-frozen-nli-model.ts: forbidden global crypto",
      "verifier-frozen-nli-model.ts: forbidden global crypto",
    ]);
    const hostileGlobalAliases = ts.createSourceFile(
      "verifier-frozen-nli-model.ts",
      "global.crypto.randomUUID(); self.crypto.randomUUID(); window.crypto.randomUUID();",
      ts.ScriptTarget.Latest,
      true,
    );
    const globalAliasViolations: string[] = [];
    visit(hostileGlobalAliases, "verifier-frozen-nli-model.ts", globalAliasViolations);
    expect(globalAliasViolations).toEqual([
      "verifier-frozen-nli-model.ts: forbidden global global",
      "verifier-frozen-nli-model.ts: forbidden global self",
      "verifier-frozen-nli-model.ts: forbidden global window",
    ]);
    const hostileEscapes = ts.createSourceFile(
      "verifier-frozen-nli-model.ts",
      'import c = require("node:crypto"); export { c }; (() => {}).constructor("return globalThis")(); (() => {})["constructor"]("return globalThis")(); const { constructor: C } = (() => {}); const { ["con" + "structor"]: D } = (() => {}); Reflect.get(() => {}, "constructor")("return globalThis")();',
      ts.ScriptTarget.Latest,
      true,
    );
    const escapeViolations: string[] = [];
    visit(hostileEscapes, "verifier-frozen-nli-model.ts", escapeViolations);
    expect(escapeViolations).toEqual([
      "verifier-frozen-nli-model.ts: import equals",
      "verifier-frozen-nli-model.ts: forbidden property constructor",
      "verifier-frozen-nli-model.ts: forbidden property constructor",
      "verifier-frozen-nli-model.ts: forbidden property constructor",
      "verifier-frozen-nli-model.ts: forbidden property constructor",
      "verifier-frozen-nli-model.ts: forbidden property constructor",
    ]);
  });
});

function collectBoundaryGraph(violations: string[]): ReadonlyMap<string, ts.SourceFile> {
  const files = new Map<string, ts.SourceFile>();
  const pending = [...boundaryRoots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) continue;
    const url = new URL(`../../src/evidence/${file}`, import.meta.url);
    if (!existsSync(url)) {
      violations.push(`${file}: missing transitive module`);
      continue;
    }
    const parsed = ts.createSourceFile(
      file,
      readFileSync(url, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    files.set(file, parsed);
    const specifiers: string[] = [];
    collectStaticSpecifiers(parsed, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith("./")) continue;
      const resolved = specifier.slice(2).replace(/\.js$/u, ".ts");
      if (!(resolved in allowedImports)) {
        violations.push(`${file}: transitive module lacks allowlist ${resolved}`);
      }
      pending.push(resolved);
    }
  }
  return files;
}

function collectStaticSpecifiers(node: ts.Node, specifiers: string[]): void {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    specifiers.push(node.moduleSpecifier.text);
  }
  ts.forEachChild(node, (child) => collectStaticSpecifiers(child, specifiers));
}

function visit(node: ts.Node, file: string, violations: string[]): void {
  if (ts.isImportEqualsDeclaration(node)) {
    violations.push(`${file}: import equals`);
  }
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    !allowedImports[file]?.has(node.moduleSpecifier.text)
  ) {
    violations.push(`${file}: unapproved module ${node.moduleSpecifier.text}`);
  }
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    !node.moduleSpecifier.text.startsWith(".") &&
    allowedImports[file]?.has(node.moduleSpecifier.text)
  ) {
    const allowed = allowedExternalBindings[node.moduleSpecifier.text];
    for (const binding of staticBindings(node)) {
      if (!allowed?.has(binding)) {
        violations.push(`${file}: unapproved binding ${binding} from ${node.moduleSpecifier.text}`);
      }
    }
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    violations.push(`${file}: dynamic import`);
  }
  if (isForbiddenPropertyEscape(node)) {
    violations.push(`${file}: forbidden property constructor`);
  }
  if (
    ts.isIdentifier(node) &&
    forbiddenGlobals.has(node.text) &&
    !isPropertyName(node) &&
    !isImportBinding(node)
  ) {
    violations.push(`${file}: forbidden global ${node.text}`);
  }
  ts.forEachChild(node, (child) => visit(child, file, violations));
}

function isForbiddenPropertyEscape(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && isReflectiveConstructorLookup(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "constructor";
  if (ts.isBindingElement(node)) {
    return staticPropertyName(node.propertyName ?? node.name) === "constructor";
  }
  return (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    staticExpressionString(node.argumentExpression) === "constructor"
  );
}

function isReflectiveConstructorLookup(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const target = node.expression.expression;
  if (
    !ts.isIdentifier(target) ||
    (target.text !== "Reflect" && target.text !== "Object") ||
    (node.expression.name.text !== "get" &&
      node.expression.name.text !== "getOwnPropertyDescriptor")
  ) {
    return false;
  }
  return node.arguments.some((argument) => staticExpressionString(argument) === "constructor");
}

function staticPropertyName(node: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return ts.isComputedPropertyName(node) ? staticExpressionString(node.expression) : undefined;
}

function staticExpressionString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticExpressionString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticExpressionString(node.left);
    const right = staticExpressionString(node.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  return undefined;
}

function staticBindings(node: ts.ImportDeclaration | ts.ExportDeclaration): readonly string[] {
  if (ts.isExportDeclaration(node)) {
    if (node.exportClause === undefined) return ["wildcard"];
    if (!ts.isNamedExports(node.exportClause)) return ["namespace"];
    return node.exportClause.elements.map(
      (element) => element.propertyName?.text ?? element.name.text,
    );
  }
  const clause = node.importClause;
  if (clause === undefined) return ["side-effect"];
  const bindings: string[] = [];
  if (clause.name !== undefined) bindings.push("default");
  if (clause.namedBindings === undefined) return bindings;
  if (ts.isNamespaceImport(clause.namedBindings)) return [...bindings, "namespace"];
  for (const element of clause.namedBindings.elements) {
    bindings.push(element.propertyName?.text ?? element.name.text);
  }
  return bindings;
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent)) &&
      parent.name === node)
  );
}

function isImportBinding(node: ts.Identifier): boolean {
  return (
    ts.isImportClause(node.parent) ||
    ts.isImportSpecifier(node.parent) ||
    ts.isNamespaceImport(node.parent)
  );
}
