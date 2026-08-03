/// <reference types="bun" />

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import ts from "typescript";

const allowedImports: Readonly<Record<string, ReadonlySet<string>>> = {
  "verifier-conformance-canonical.ts": new Set(["node:crypto", "zod"]),
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
  "Date",
  "EventSource",
  "Function",
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
]);
const boundaryRoots = ["verifier-registry.ts"];

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
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    !allowedImports[file]?.has(node.moduleSpecifier.text)
  ) {
    violations.push(`${file}: unapproved module ${node.moduleSpecifier.text}`);
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    violations.push(`${file}: dynamic import`);
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
