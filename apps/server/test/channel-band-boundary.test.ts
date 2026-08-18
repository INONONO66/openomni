import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Channels band-extraction readiness gate (#499 precursor).
 *
 * The future channels band depends on @openomni/protocol plus the leaf
 * @openomni/telemetry: channel code observes through the injected publish
 * port (channel/types.ts), speaks the Channel.SurfaceKey codec, and mints
 * W3C trace ids at its genuine trace origins (D11 — gateway events, inbound
 * frames). #499's text pinned the band to {protocol, ipc}; this amendment
 * (+telemetry, PR #653) is recorded on that issue for Owner review — an
 * injected-mint port would be one-off ceremony for a pure leaf function no
 * other band bothers with. This static scan pins the seam — every import in
 * apps/server/src/channel/** must be one of the allowed packages, a node
 * builtin, or relative. When the band MOVE lands (post-#499) this gate
 * travels with it as the package's import contract.
 */

const CHANNEL_ROOT = fileURLToPath(new URL("../src/channel", import.meta.url));
const ALLOWED_PACKAGES = ["@openomni/protocol", "@openomni/telemetry"] as const;

/**
 * Gateway amendment (docs/gateway-design.md §1/§8.2, Owner 2026-08-18/19):
 * perimeter JUDGMENT code may import the shared policy engine — driver code
 * may not. Today the only judgment sites in the band are under
 * `channel/authn/`; they travel to the gateway router band at stage 2
 * (#707), taking this allowance with them. Everything else in channel/**
 * stays on the dumb-driver contract.
 */
const JUDGMENT_DIR = "src/channel/authn/";
const JUDGMENT_EXTRA_PACKAGES = ["@openomni/policy"] as const;

type ScannedSource = Readonly<{ path: string; text: string }>;

function channelSources(): readonly ScannedSource[] {
  return readdirSync(CHANNEL_ROOT, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => {
      const path = join(CHANNEL_ROOT, entry);
      return { path: join("src/channel", entry), text: readFileSyncText(path) };
    });
}

function readFileSyncText(path: string): string {
  return ts.sys.readFile(path) ?? "";
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
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          specifiers.push(argument.text);
        } else {
          // A non-literal dynamic import cannot be verified statically —
          // treat it as a violation (the telegram surface used exactly this
          // shape to smuggle a session import past a plain-text scan).
          specifiers.push("<non-literal dynamic import>");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function isAllowedSpecifier(specifier: string, path: string): boolean {
  for (const allowed of ALLOWED_PACKAGES) {
    if (specifier === allowed) return true;
    if (specifier.startsWith(`${allowed}/`)) return true;
  }
  if (path.startsWith(JUDGMENT_DIR)) {
    for (const allowed of JUDGMENT_EXTRA_PACKAGES) {
      if (specifier === allowed) return true;
      if (specifier.startsWith(`${allowed}/`)) return true;
    }
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
  if (specifier.startsWith("node:")) return true;
  return false;
}

function detectBandViolations(sources: readonly ScannedSource[]): readonly string[] {
  const violations: string[] = [];
  for (const { path, text } of sources) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const specifier of collectModuleSpecifiers(source)) {
      if (!isAllowedSpecifier(specifier, path)) {
        violations.push(`${path}: imports ${specifier}`);
      }
    }
  }
  return violations;
}

describe("channels band import boundary", () => {
  it("scans the real channel tree, not an empty directory", () => {
    expect(channelSources().length).toBeGreaterThan(10);
  });

  it("keeps channel/* on the band contract: protocol, node builtins, relative only", () => {
    expect(detectBandViolations(channelSources())).toEqual([]);
  });

  const violationFixtures = [
    [
      "named session import",
      'import { Storage } from "@openomni/session";',
      "imports @openomni/session",
    ],
    [
      "type-only session import",
      'import type { SurfaceKey } from "@openomni/session";',
      "imports @openomni/session",
    ],
    [
      "namespace session import",
      'import * as Session from "@openomni/session";',
      "imports @openomni/session",
    ],
    [
      "session re-export",
      'export { SurfaceKey } from "@openomni/session";',
      "imports @openomni/session",
    ],
    [
      "dynamic session import",
      'const { SurfaceKey } = await import("@openomni/session");',
      "imports @openomni/session",
    ],
    [
      "require of the kernel",
      'const oo = require("@openomni/openomni");',
      "imports @openomni/openomni",
    ],
    [
      "import-equals require",
      'import session = require("@openomni/session");',
      "imports @openomni/session",
    ],
    ["arbitrary npm package", 'import { z } from "zod";', "imports zod"],
    [
      "non-literal dynamic import",
      "const mod = await import(moduleName);",
      "imports <non-literal dynamic import>",
    ],
  ] as const;

  for (const [name, text, violation] of violationFixtures) {
    it(`detects ${name}`, () => {
      const path = "src/channel/synthetic.ts";
      expect(detectBandViolations([{ path, text }])).toContain(`${path}: ${violation}`);
    });
  }

  it("allows protocol, telemetry, node builtin, and relative imports", () => {
    const text = [
      'import { Channel, Operational } from "@openomni/protocol";',
      'import { newTraceId } from "@openomni/telemetry";',
      'import { timingSafeEqual } from "node:crypto";',
      'import type { PublishPort } from "../types";',
      'import { GatewayOp } from "./types";',
      'export * from "./surface.js";',
    ].join("\n");
    expect(detectBandViolations([{ path: "src/channel/synthetic.ts", text }])).toEqual([]);
  });
});
