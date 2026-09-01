import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CHANNEL_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const DRIVER_ALLOWED_PACKAGES = new Set(["@openomni/protocol"]);
const JUDGMENT_ALLOWED_PACKAGES = new Set(["@openomni/policy", "@openomni/ledger"]);
const JUDGMENT_DIRS = ["src/router/", "src/authn/"] as const;

type ScannedSource = Readonly<{ path: string; text: string }>;

function channelSources(): readonly ScannedSource[] {
  return readdirSync(CHANNEL_ROOT, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => ({
      path: join("src", entry),
      text: ts.sys.readFile(join(CHANNEL_ROOT, entry)) ?? "",
    }));
}

function collectModuleSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      specifiers.push(
        argument !== undefined && ts.isStringLiteralLike(argument)
          ? argument.text
          : "<non-literal dynamic import>",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function packageName(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/", 1)[0] ?? specifier;
  return specifier.split("/", 2).join("/");
}

function isAllowed(specifier: string, path: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("node:")) {
    return true;
  }
  const dependency = packageName(specifier);
  if (DRIVER_ALLOWED_PACKAGES.has(dependency)) return true;
  return (
    JUDGMENT_DIRS.some((directory) => path.startsWith(directory)) &&
    JUDGMENT_ALLOWED_PACKAGES.has(dependency)
  );
}

function detectBandViolations(sources: readonly ScannedSource[]): readonly string[] {
  const violations: string[] = [];
  for (const { path, text } of sources) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const specifier of collectModuleSpecifiers(source)) {
      if (!isAllowed(specifier, path)) violations.push(`${path}: imports ${specifier}`);
    }
  }
  return violations;
}

describe("channels band import boundary", () => {
  test("keeps the real source tree on its package allowlist", () => {
    expect(detectBandViolations(channelSources())).toEqual([]);
  });

  test("rejects arbitrary external packages", () => {
    expect(
      detectBandViolations([{ path: "src/websocket.ts", text: 'import { z } from "zod";' }]),
    ).toEqual(["src/websocket.ts: imports zod"]);
  });

  test("rejects non-literal dynamic imports", () => {
    expect(
      detectBandViolations([
        { path: "src/websocket.ts", text: "const loaded = await import(moduleName);" },
      ]),
    ).toEqual(["src/websocket.ts: imports <non-literal dynamic import>"]);
  });

  test("rejects import-equals require from a driver", () => {
    expect(
      detectBandViolations([
        {
          path: "src/websocket.ts",
          text: 'import Ledger = require("@openomni/ledger");',
        },
      ]),
    ).toEqual(["src/websocket.ts: imports @openomni/ledger"]);
  });
});
