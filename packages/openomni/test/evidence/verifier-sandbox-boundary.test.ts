/// <reference types="bun" />

import { readFileSync } from "node:fs";
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
  "setImmediate",
  "setInterval",
  "setTimeout",
]);
const boundaryFiles = [
  "verifier-conformance-canonical.ts",
  "verifier-registry-contract.ts",
  "verifier-registry-core.ts",
  "verifier-registry-evaluators.ts",
  "verifier-sandbox.ts",
  "verifier-frozen-nli-model.ts",
  "verifier-registry.ts",
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

    const hostile = ts.createSourceFile(
      "hostile.ts",
      'globalThis["fetch"]("https://example.test"); import("node:https");',
      ts.ScriptTarget.Latest,
      true,
    );
    const hostileViolations: string[] = [];
    visit(hostile, "hostile.ts", hostileViolations);
    expect(hostileViolations).toEqual([
      "hostile.ts: forbidden global globalThis",
      "hostile.ts: dynamic import",
    ]);
  });
});

function visit(node: ts.Node, file: string, violations: string[]): void {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    !allowedImports[file]?.has(node.moduleSpecifier.text)
  ) {
    violations.push(`${file}: unapproved import ${node.moduleSpecifier.text}`);
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
