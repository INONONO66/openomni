/// <reference types="bun" />

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import ts from "typescript";

const forbiddenImports = new Set([
  "node:child_process",
  "node:cluster",
  "node:dgram",
  "node:dns",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:worker_threads",
]);
const forbiddenGlobals = new Set([
  "Bun",
  "Date",
  "EventSource",
  "Function",
  "WebSocket",
  "Worker",
  "eval",
  "fetch",
  "performance",
  "process",
  "setImmediate",
  "setInterval",
  "setTimeout",
]);
const boundaryFiles = [
  "verifier-registry-evaluators.ts",
  "verifier-sandbox.ts",
  "verifier-frozen-nli-model.ts",
];

describe("verifier sandbox structural boundary", () => {
  test("forbids ambient effect imports and globals in the verifier path", () => {
    const violations: string[] = [];
    for (const file of boundaryFiles) {
      const source = readFileSync(new URL(`../../src/evidence/${file}`, import.meta.url), "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      visit(parsed, file, violations);
    }
    expect(violations).toEqual([]);
  });
});

function visit(node: ts.Node, file: string, violations: string[]): void {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    forbiddenImports.has(node.moduleSpecifier.text)
  ) {
    violations.push(`${file}: forbidden import ${node.moduleSpecifier.text}`);
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
