import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Channels band import contract (#551 stage 1 — the extraction gate that
 * traveled with the driver-band extraction).
 *
 * The channels package whitelist at gateway stage 1 is {protocol, ipc,
 * policy} (docs/gateway-design.md §1/§9; ledger arrives at stage 2): channel
 * code observes through the injected publish port (src/types.ts), speaks the
 * protocol Channel.SurfaceKey codec, and mints W3C trace ids via protocol's
 * newTraceId at its genuine trace origins (D11 — gateway events, inbound
 * frames). The pre-move telemetry allowance (PR #653) is DROPPED: since the
 * trace-id mint moved into protocol, the band imports telemetry zero times —
 * verified at extraction. This static scan pins the seam — every import in
 * src/** must be one of the allowed packages, a node builtin, or relative.
 */

const CHANNEL_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const ALLOWED_PACKAGES = ["@openomni/protocol", "@openomni/ipc"] as const;

/**
 * Gateway amendment (docs/gateway-design.md §1/§8.2, Owner 2026-08-18/19;
 * stage-2 shape #707): perimeter JUDGMENT code — the gateway router band
 * (`src/router/`: routing, wait service, send kernel) and the channel authn
 * sites (`src/authn/`) — may import the shared policy engine and the
 * ledger's perimeter store surfaces. Driver code may not (S8 banding; the
 * same rule plus the perimeter-surface pin is enforced repo-wide by
 * script/check-deps.ts). Everything else in src/** stays on the dumb-driver
 * contract {protocol, ipc}. Telemetry stays forbidden EVERYWHERE in src/**:
 * the band observes through the injected `BusEvent.Sink` port only.
 */
const JUDGMENT_DIRS = ["src/router/", "src/authn/"] as const;
const JUDGMENT_EXTRA_PACKAGES = ["@openomni/policy", "@openomni/ledger"] as const;

type ScannedSource = Readonly<{ path: string; text: string }>;

function channelSources(): readonly ScannedSource[] {
  return readdirSync(CHANNEL_ROOT, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => {
      const path = join(CHANNEL_ROOT, entry);
      return { path: join("src", entry), text: readFileSyncText(path) };
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
  if (JUDGMENT_DIRS.some((dir) => path.startsWith(dir))) {
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

  it("keeps src/* on the band contract: protocol, ipc, node builtins, relative only", () => {
    expect(detectBandViolations(channelSources())).toEqual([]);
  });

  // Ledger fixtures INVERTED at stage 2 (#707): the same import that is a
  // violation in a driver file is legal in the router judgment band — the
  // router is the ledger's sole perimeter writing consumer.
  const driverOnlyViolationFixtures = [
    [
      "named ledger import in a driver",
      'import { Storage } from "@openomni/ledger";',
      "imports @openomni/ledger",
    ],
    [
      "type-only ledger import in a driver",
      'import type { SurfaceKey } from "@openomni/ledger";',
      "imports @openomni/ledger",
    ],
    [
      "namespace ledger import in a driver",
      'import * as Session from "@openomni/ledger";',
      "imports @openomni/ledger",
    ],
    [
      "ledger re-export in a driver",
      'export { SurfaceKey } from "@openomni/ledger";',
      "imports @openomni/ledger",
    ],
    [
      "dynamic ledger import in a driver",
      'const { SurfaceKey } = await import("@openomni/ledger");',
      "imports @openomni/ledger",
    ],
    [
      "import-equals require of the ledger in a driver",
      'import session = require("@openomni/ledger");',
      "imports @openomni/ledger",
    ],
    [
      "policy import outside the judgment band",
      'import { evaluatePermission } from "@openomni/policy";',
      "imports @openomni/policy",
    ],
  ] as const;

  for (const [name, text, violation] of driverOnlyViolationFixtures) {
    it(`detects ${name} (and allows it in the router band)`, () => {
      const driverPath = "src/synthetic.ts";
      expect(detectBandViolations([{ path: driverPath, text }])).toContain(
        `${driverPath}: ${violation}`,
      );
      expect(detectBandViolations([{ path: "src/router/synthetic.ts", text }])).toEqual([]);
    });
  }

  // Forbidden EVERYWHERE in src/** — including the router judgment band.
  const everywhereViolationFixtures = [
    ["arbitrary npm package", 'import { z } from "zod";', "imports zod"],
    [
      "telemetry import (observation goes through the injected sink)",
      'import { newTraceId } from "@openomni/telemetry";',
      "imports @openomni/telemetry",
    ],
    [
      "non-literal dynamic import",
      "const mod = await import(moduleName);",
      "imports <non-literal dynamic import>",
    ],
  ] as const;

  for (const [name, text, violation] of everywhereViolationFixtures) {
    it(`detects ${name} in every band`, () => {
      for (const path of [
        "src/synthetic.ts",
        "src/router/synthetic.ts",
        "src/authn/synthetic.ts",
      ]) {
        expect(detectBandViolations([{ path, text }])).toContain(`${path}: ${violation}`);
      }
    });
  }

  it("allows protocol, ipc, node builtin, and relative imports", () => {
    const text = [
      'import { Channel, Operational, newTraceId } from "@openomni/protocol";',
      'import { IpcConnectionError } from "@openomni/ipc";',
      'import { timingSafeEqual } from "node:crypto";',
      'import type { PublishPort } from "../types";',
      'import { GatewayOp } from "./types";',
      'export * from "./surface.js";',
    ].join("\n");
    expect(detectBandViolations([{ path: "src/synthetic.ts", text }])).toEqual([]);
  });

  it("allows the policy engine only under the judgment band (router + authn)", () => {
    const text = 'import { evaluatePermission } from "@openomni/policy";';
    expect(detectBandViolations([{ path: "src/authn/synthetic.ts", text }])).toEqual([]);
    expect(detectBandViolations([{ path: "src/router/synthetic.ts", text }])).toEqual([]);
    expect(detectBandViolations([{ path: "src/discord/synthetic.ts", text }])).toEqual([
      "src/discord/synthetic.ts: imports @openomni/policy",
    ]);
  });

  it("allows the ledger only under the judgment band, never in a driver dir", () => {
    const text = 'import { WaitStore } from "@openomni/ledger";';
    expect(detectBandViolations([{ path: "src/router/wait/synthetic.ts", text }])).toEqual([]);
    for (const path of [
      "src/discord/synthetic.ts",
      "src/telegram/synthetic.ts",
      "src/github/synthetic.ts",
      "src/support/synthetic.ts",
      "src/websocket.ts",
    ]) {
      expect(detectBandViolations([{ path, text }])).toEqual([`${path}: imports @openomni/ledger`]);
    }
  });
});
