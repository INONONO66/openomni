import { Glob } from "bun";

type PackageKey =
  | "protocol"
  | "ipc"
  | "telemetry"
  | "policy"
  | "ledger"
  | "llm"
  | "agent"
  | "openomni"
  | "coordinator"
  | "channels"
  | "server";

type PackageRule = {
  displayName: string;
  packageJsonPath: string;
  packageName: string;
  allowedDeps: "none" | "any-except-self" | Set<string>;
  /**
   * Tighter allowlist for `<pkg>/src/` alone, when a package's runtime surface
   * is narrower than what its tests need. Without it a test-only dependency
   * silently re-permits the same import in production code, which is how a
   * closed boundary reopens without any gate noticing.
   */
  srcAllowedDeps?: Set<string>;
};

const SHOW_FIX_SUGGESTIONS = Bun.argv.includes("--fix-suggestions");

// Known deep import violations (tracked tech debt — do not extend)
// Keyed by "file:importPath" to avoid file-wide exemptions that could hide new violations.
const KNOWN_DEEP_IMPORTS = new Set([
  "apps/server/src/tool/mcp/provider.ts:@openomni/agent/src/runtime/mcp",
  "apps/server/src/index.ts:@openomni/agent/src/runtime/mcp",
]);

const KNOWN_DEEP_RELATIVE_IMPORTS = new Set([
  "packages/openomni/src/execution-runtime/tool/agent/provider.ts:../../../dispatch/index.js",
  "packages/openomni/src/execution-runtime/tool/agent/tools/child-agent.ts:../../../child-agent/index.js",
  "packages/openomni/src/execution-runtime/tool/agent/tools/dispatch.ts:../../../../dispatch/runtime.js",
]);

const RULES: Record<PackageKey, PackageRule> = {
  protocol: {
    displayName: "protocol",
    packageJsonPath: "packages/protocol/package.json",
    packageName: "@openomni/protocol",
    allowedDeps: "none",
  },
  telemetry: {
    displayName: "telemetry",
    packageJsonPath: "packages/telemetry/package.json",
    packageName: "@openomni/telemetry",
    // Ring-1 observation channel (#606): protocol only. It must stay a leaf —
    // replacing it with no-ops has to leave observed behavior identical, so it
    // can never reach for storage or decisions.
    allowedDeps: new Set(["@openomni/protocol"]),
  },
  ipc: {
    displayName: "ipc",
    packageJsonPath: "packages/ipc/package.json",
    packageName: "@openomni/ipc",
    // Worker-process transport contract (#496): protocol only. Driver-band
    // packages (channels, remote, browser, machines, …) consume it as a
    // published contract — it must never grow a kernel/ledger/policy import.
    allowedDeps: new Set(["@openomni/protocol"]),
  },
  ledger: {
    displayName: "ledger",
    packageJsonPath: "packages/ledger/package.json",
    packageName: "@openomni/ledger",
    allowedDeps: new Set(["@openomni/protocol", "@openomni/telemetry"]),
  },
  policy: {
    displayName: "policy",
    packageJsonPath: "packages/policy/package.json",
    packageName: "@openomni/policy",
    allowedDeps: new Set(["@openomni/protocol"]),
  },
  llm: {
    displayName: "llm",
    packageJsonPath: "packages/llm/package.json",
    packageName: "@openomni/llm",
    // The manifest may carry `telemetry` — the tests bind `Bus`/`collector`
    // behind the port, and `check-deps` counts devDependencies.
    allowedDeps: new Set(["@openomni/protocol", "@openomni/telemetry"]),
    // `src/` may not. It reports through an injected `BusEvent.Sink` and
    // imports no implementation of the observation channel at all (#606).
    srcAllowedDeps: new Set(["@openomni/protocol"]),
  },
  agent: {
    displayName: "agent",
    packageJsonPath: "packages/agent/package.json",
    packageName: "@openomni/agent",
    // The manifest may carry `telemetry` — the tests bind `Bus` behind the
    // port, and `check-deps` counts devDependencies.
    allowedDeps: new Set([
      "@openomni/protocol",
      "@openomni/policy",
      "@openomni/llm",
      "@openomni/telemetry",
    ]),
    // `src/` may not. The loop reports through an injected `BusEvent.Sink`
    // and owns no durable state (#606).
    srcAllowedDeps: new Set(["@openomni/protocol", "@openomni/policy", "@openomni/llm"]),
  },
  openomni: {
    displayName: "openomni",
    packageJsonPath: "packages/openomni/package.json",
    packageName: "@openomni/openomni",
    allowedDeps: "any-except-self",
  },
  coordinator: {
    displayName: "coordinator",
    packageJsonPath: "packages/coordinator/package.json",
    packageName: "@openomni/coordinator",
    // Ring-2 process driver: protocol + ipc only (#462 step 1 made it
    // ledger-free; #496 moved the IPC transport into @openomni/ipc; this
    // ratchet keeps it that way — widening requires Owner sign-off).
    allowedDeps: new Set(["@openomni/protocol", "@openomni/ipc"]),
  },
  channels: {
    displayName: "channels",
    packageJsonPath: "packages/channels/package.json",
    packageName: "@openomni/channels",
    // Gateway band at stage 2 (#707, docs/gateway-design.md §1/§9): protocol
    // for the contracts, ipc as the driver-band transport contract, policy +
    // ledger for the judgment band (S8 confines them to src/router/ +
    // src/authn/ — see validateChannelsIntraPackageBanding, which also pins
    // the router to the PERIMETER ledger surfaces only). The manifest may
    // carry `telemetry` — the tests observe the real Bus (the llm/agent
    // precedent), and `check-deps` counts devDependencies.
    allowedDeps: new Set([
      "@openomni/protocol",
      "@openomni/ipc",
      "@openomni/policy",
      "@openomni/ledger",
      "@openomni/telemetry",
    ]),
    // `src/` may not touch telemetry: the band observes through an injected
    // `BusEvent.Sink` port only. No kernel either way (openomni↔channels = 0).
    srcAllowedDeps: new Set([
      "@openomni/protocol",
      "@openomni/ipc",
      "@openomni/policy",
      "@openomni/ledger",
    ]),
  },
  server: {
    displayName: "server",
    packageJsonPath: "apps/server/package.json",
    packageName: "@openomni/server",
    allowedDeps: "any-except-self",
  },
};

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** The layer check for `<pkg>/src/`, which may be stricter than the manifest's. */
function isAllowedSourceDep(rule: PackageRule, dep: string): boolean {
  if (!dep.startsWith("@openomni/")) return true;
  return rule.srcAllowedDeps === undefined ? isAllowedDep(rule, dep) : rule.srcAllowedDeps.has(dep);
}

function isAllowedDep(rule: PackageRule, dep: string): boolean {
  if (!dep.startsWith("@openomni/")) {
    return true;
  }

  if (rule.allowedDeps === "none") {
    return false;
  }

  if (rule.allowedDeps === "any-except-self") {
    return dep !== rule.packageName;
  }

  return rule.allowedDeps.has(dep);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    throw new Error(`Missing required file: ${path}`);
  }

  const text = await file.text();
  return JSON.parse(text) as Record<string, unknown>;
}

function collectOpenOmniDeps(pkg: Record<string, unknown>): string[] {
  const deps = new Set<string>();

  for (const field of DEP_FIELDS) {
    const value = pkg[field];

    if (!value || typeof value !== "object") {
      continue;
    }

    for (const depName of Object.keys(value as Record<string, string>)) {
      if (depName.startsWith("@openomni/")) {
        deps.add(depName);
      }
    }
  }

  return Array.from(deps).sort();
}

function isTestFile(path: string): boolean {
  if (path.includes("/test/") || path.includes("/tests/") || path.includes("/__tests__/")) {
    return true;
  }

  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".spec.ts") ||
    path.endsWith(".test.tsx") ||
    path.endsWith(".spec.tsx")
  );
}

/**
 * Paths never scanned: build output, dependencies, tests, the gate scripts
 * themselves, and untracked local dirs — research clones pinned under tmp/
 * (#533) and nested worktrees under .claude/ — which would otherwise break
 * local runs while CI stays green (#552).
 */
function isExcludedFromScan(filePath: string): boolean {
  return (
    filePath.includes("/node_modules/") ||
    filePath.startsWith("node_modules/") ||
    filePath.includes("/dist/") ||
    filePath.startsWith("dist/") ||
    filePath.startsWith("tmp/") ||
    filePath.startsWith(".claude/") ||
    isTestFile(filePath) ||
    filePath.startsWith("script/")
  );
}

function lineNumberForOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function suggestBarrelImport(importPath: string): string {
  const packageName = importPath.match(/^(@openomni\/[^/]+)/)?.[1];
  return packageName ?? importPath;
}

function parentTraversalDepth(importPath: string): number {
  let depth = 0;
  for (const segment of importPath.split("/")) {
    if (segment !== "..") {
      break;
    }
    depth += 1;
  }
  return depth;
}

async function validateDependencyDirection(): Promise<string[]> {
  const violations: string[] = [];

  for (const rule of Object.values(RULES)) {
    const pkgJson = await readJson(rule.packageJsonPath);
    const deps = collectOpenOmniDeps(pkgJson);

    for (const dep of deps) {
      if (!isAllowedDep(rule, dep)) {
        violations.push(
          `VIOLATION: ${rule.displayName} depends on ${dep} — not allowed by layer order`,
        );
      }
    }
  }

  return violations;
}

function packageDirOf(rule: PackageRule): string {
  return rule.packageJsonPath.replace(/\/package\.json$/, "");
}

/**
 * Layer-order check at the source level. package.json manifests cannot see
 * phantom imports (a bare `import "@openomni/ledger"` resolves through the
 * hoisted node_modules even when the manifest never declares it), so the
 * dependency-direction rules are enforced against actual import specifiers.
 */
async function validateSourceImportDirection(): Promise<string[]> {
  const violations: string[] = [];
  const owners = Object.values(RULES).map((rule) => ({
    rule,
    srcPrefix: `${packageDirOf(rule)}/src/`,
  }));
  const importPattern =
    /(?:from\s+|import\s+|import\s*\(\s*)["'](@openomni\/[^"'/]+)(?:\/[^"']*)?["']/g;
  const sourceGlob = new Glob("**/*.ts");

  for await (const filePath of sourceGlob.scan({
    cwd: ".",
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (isExcludedFromScan(filePath)) {
      continue;
    }

    const owner = owners.find(({ srcPrefix }) => filePath.startsWith(srcPrefix));
    if (!owner) continue;

    const source = await Bun.file(filePath).text();
    for (const match of source.matchAll(importPattern)) {
      const dep = match[1];
      if (dep && !isAllowedSourceDep(owner.rule, dep)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} source-imports ${dep} — not allowed by layer order for ${owner.rule.displayName} (manifest check cannot see phantom imports)`,
        );
      }
    }
  }

  return violations;
}

const CHANNELS_SRC_PREFIX = "packages/channels/src/";
const CHANNELS_ROUTER_PREFIX = "packages/channels/src/router/";
const CHANNELS_JUDGMENT_PREFIXES = [
  CHANNELS_ROUTER_PREFIX,
  "packages/channels/src/authn/",
] as const;
const CHANNELS_JUDGMENT_ONLY_DEPS = new Set(["@openomni/policy", "@openomni/ledger"]);

/**
 * The perimeter store surfaces the gateway router may name from
 * @openomni/ledger (docs/gateway-design.md §4/§6): actors, blacklist,
 * channel grants, waits, the surface↔session map, the frozen pending-*
 * stores, and the SCOPED append port (append + headFact — never the master
 * `Storage` entry, whose adapter reaches every brain surface). Brain
 * surfaces (Session, WorkItem*, transcript, artifact, worker-run/grant,
 * effect, …) are NOT reachable from the router — the gateway selects
 * sessions but never reads or writes session content (S1), and domain
 * isolation inside the one DB is by store surface (S2).
 */
const CHANNELS_ROUTER_LEDGER_SURFACES = new Set([
  "ActorRegistry",
  "BlacklistStore",
  "ChannelGrantStore",
  "WaitStore",
  "SurfaceKey",
  "PendingAskStore",
  "PendingInteractionStore",
  "LedgerAppend",
]);

function isChannelsJudgmentPath(filePath: string): boolean {
  return CHANNELS_JUDGMENT_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

/**
 * S8 intra-package banding for the channels gateway (docs/gateway-design.md
 * §7 S8; stage-2 shape, #707). The package-level whitelist admits
 * @openomni/policy and @openomni/ledger, but only the perimeter JUDGMENT
 * band — `src/router/` (routing, wait service, send kernel) and `src/authn/`
 * (channel authn) — may use them. The driver sub-band (discord/, github/,
 * telegram/, support/, websocket.ts, channel-authn.ts) stays on the
 * dumb-driver contract {protocol, ipc}: adding a platform = one driver file
 * + one server registration line, zero security review of the router.
 */
function isChannelsBandingViolation(filePath: string, dep: string): boolean {
  if (!filePath.startsWith(CHANNELS_SRC_PREFIX)) return false;
  if (!CHANNELS_JUDGMENT_ONLY_DEPS.has(dep)) return false;
  return !isChannelsJudgmentPath(filePath);
}

/**
 * S8 driver→router edge ban (#707): a file outside the judgment band may not
 * relative-import anything under `src/router/` — the router is reached only
 * through the composition root's injected ports, never laterally from a
 * driver. (`src/authn/` stays importable: channel-authn.ts is the drivers'
 * authn entry and predates the router band.)
 */
function isChannelsDriverRouterEdge(filePath: string, importPath: string): boolean {
  if (!filePath.startsWith(CHANNELS_SRC_PREFIX)) return false;
  if (isChannelsJudgmentPath(filePath)) return false;
  // The package barrel is the composition root's export surface, not a
  // driver — it is how apps/server reaches createGatewayRouter at all.
  if (filePath === "packages/channels/src/index.ts") return false;
  if (!importPath.startsWith(".")) return false;
  const baseDir = filePath.split("/").slice(0, -1);
  const segments = [...baseDir];
  for (const segment of importPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/").startsWith(CHANNELS_ROUTER_PREFIX);
}

/**
 * S8 router↔ledger surface pin (#707): a judgment-band file importing
 * @openomni/ledger may name ONLY the perimeter surfaces, through static
 * named `import`/`export … from` clauses. Everything else is refused
 * outright — namespace/default imports, `export *` re-exports, dynamic
 * `import(...)`, and `require(...)` would all reach (or launder to relative
 * importers) every brain surface the named scan pins out. The named clause
 * is the ONLY road.
 */
function channelsRouterLedgerViolations(filePath: string, source: string): string[] {
  if (!isChannelsJudgmentPath(filePath)) return [];
  const violations: string[] = [];
  const namedPattern =
    /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@openomni\/ledger["']/g;
  const broadPattern =
    /import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']@openomni\/ledger["']/g;
  const exportStarPattern = /export\s*\*\s*(?:as\s+\w+\s*)?from\s*["']@openomni\/ledger["']/g;
  const dynamicPattern =
    /(?:import\s*\(\s*|require\s*\(\s*)["'`]@openomni\/ledger(?:\/[^"'`]*)?["'`]/g;
  for (const match of source.matchAll(namedPattern)) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map(
        (entry) =>
          entry
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
            ?.trim() ?? "",
      );
    for (const name of names) {
      if (name.length > 0 && !CHANNELS_ROUTER_LEDGER_SURFACES.has(name)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} names ledger surface ${name} — S8: the gateway router may name only the perimeter store surfaces (${[...CHANNELS_ROUTER_LEDGER_SURFACES].join(", ")}), never brain surfaces`,
        );
      }
    }
  }
  for (const match of source.matchAll(broadPattern)) {
    const line = lineNumberForOffset(source, match.index);
    violations.push(
      `VIOLATION: ${filePath}:${line} uses a namespace/default import of @openomni/ledger — S8: the gateway router must name the perimeter surfaces explicitly`,
    );
  }
  for (const match of source.matchAll(exportStarPattern)) {
    const line = lineNumberForOffset(source, match.index);
    violations.push(
      `VIOLATION: ${filePath}:${line} re-exports @openomni/ledger wholesale — S8: a router barrel may not launder brain surfaces to relative importers`,
    );
  }
  for (const match of source.matchAll(dynamicPattern)) {
    const line = lineNumberForOffset(source, match.index);
    violations.push(
      `VIOLATION: ${filePath}:${line} loads @openomni/ledger dynamically — S8: the static named-import pin is the only road to the ledger from the router band`,
    );
  }
  return violations;
}

async function validateChannelsIntraPackageBanding(): Promise<string[]> {
  const violations: string[] = [];
  const importPattern =
    /(?:from\s+|import\s+|import\s*\(\s*)["'](@openomni\/[^"'/]+)(?:\/[^"']*)?["']/g;
  const relativeImportPattern = /(?:from\s+|import\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g;
  const sourceGlob = new Glob(`${CHANNELS_SRC_PREFIX}**/*.ts`);

  for await (const filePath of sourceGlob.scan({
    cwd: ".",
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (isExcludedFromScan(filePath)) {
      continue;
    }

    const source = await Bun.file(filePath).text();
    for (const match of source.matchAll(importPattern)) {
      const dep = match[1];
      if (dep && isChannelsBandingViolation(filePath, dep)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} imports ${dep} — S8 banding: only the channels judgment band (src/router/, src/authn/) may import the policy engine or the ledger; drivers stay on {protocol, ipc}`,
        );
      }
    }
    for (const match of source.matchAll(relativeImportPattern)) {
      const importPath = match[1];
      if (importPath && isChannelsDriverRouterEdge(filePath, importPath)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} imports ${importPath} — S8 banding: drivers may not reach into src/router/; the router is wired only through the composition root's injected ports`,
        );
      }
    }
    violations.push(...channelsRouterLedgerViolations(filePath, source));
  }

  return violations;
}

async function validateDeepImports(): Promise<string[]> {
  const violations: string[] = [];
  // Matches both `from "@openomni/.../src/..."` and side-effect `import "@openomni/.../src/..."`
  const importPattern = /(?:from\s+|import\s+)["'](@openomni\/[^"']+\/src\/[^"']*)["']/g;
  const sourceGlob = new Glob("**/*.ts");

  for await (const filePath of sourceGlob.scan({
    cwd: ".",
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (isExcludedFromScan(filePath)) {
      continue;
    }

    const source = await Bun.file(filePath).text();
    for (const match of source.matchAll(importPattern)) {
      const importPath = match[1];
      // Unreachable: the capture group requires >=1 char; this narrows
      // string | undefined from noUncheckedIndexedAccess, nothing more.
      if (!importPath) continue;
      const line = lineNumberForOffset(source, match.index);
      const isKnown = KNOWN_DEEP_IMPORTS.has(`${filePath}:${importPath}`);
      const prefix = isKnown ? "KNOWN" : "VIOLATION";
      const base = `${prefix}: ${filePath}:${line} imports ${importPath} — use package barrel instead`;

      if (isKnown) {
        // Print but don't count as violation
        console.warn(base);
      } else if (SHOW_FIX_SUGGESTIONS) {
        const suggested = suggestBarrelImport(importPath);
        violations.push(`${base} (suggestion: ${suggested})`);
      } else {
        violations.push(base);
      }
    }
  }

  return violations;
}

async function validateDeepRelativeImports(): Promise<string[]> {
  const violations: string[] = [];
  const importPattern = /(?:from\s+|import\s*\(\s*)["'](\.{2}\/[^"']*)["']/g;
  const sourceGlob = new Glob("**/*.ts");

  for await (const filePath of sourceGlob.scan({
    cwd: ".",
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (isExcludedFromScan(filePath)) {
      continue;
    }

    const source = await Bun.file(filePath).text();
    for (const match of source.matchAll(importPattern)) {
      const importPath = match[1];
      // Unreachable: the capture group requires >=1 char; this narrows
      // string | undefined from noUncheckedIndexedAccess, nothing more.
      if (!importPath) continue;
      const line = lineNumberForOffset(source, match.index);
      const key = `${filePath}:${importPath}`;
      const isSelfRootImport = importPath.startsWith("../../src/");
      const isDeepRelativeImport = parentTraversalDepth(importPath) >= 3;

      if (!isSelfRootImport && !isDeepRelativeImport) {
        continue;
      }

      const isKnown = KNOWN_DEEP_RELATIVE_IMPORTS.has(key);
      const prefix = isKnown ? "KNOWN" : "VIOLATION";
      const reason = isSelfRootImport ? "self-root relative import" : "deep relative import";
      const base = `${prefix}: ${filePath}:${line} imports ${importPath} — ${reason}; use a closer relative import or a domain barrel`;

      if (isKnown) {
        console.warn(base);
      } else {
        violations.push(base);
      }
    }
  }

  return violations;
}

// See docs/golden-principles.local.md for the full list.

// Allowed `as any` locations (pre-existing tech debt — do not extend).
// protocol/error was removed 2026-08 (#552 item 5): zero remaining hits.
const ALLOWED_AS_ANY_FILES = new Set([
  "packages/openomni/src/ingress/event-projector.ts",
  "packages/agent/src/runtime/messenger/transport.ts",
]);

// Known catch-all filenames (pre-existing tech debt)
const KNOWN_CATCHALL_FILES = new Set<string>();

// Known empty catch blocks (pre-existing tech debt — do not extend)
// Keyed by "file:line" to track exact locations.
const KNOWN_EMPTY_CATCHES = new Set<string>();

async function validateGoldenPrinciples(): Promise<string[]> {
  const violations: string[] = [];
  const sourceGlob = new Glob("**/*.ts");

  for await (const filePath of sourceGlob.scan({
    cwd: ".",
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (isExcludedFromScan(filePath)) {
      continue;
    }

    const source = await Bun.file(filePath).text();
    const lines = source.split("\n");

    for (const [index, line] of lines.entries()) {
      const lineNum = index + 1;

      // #5: No `as any` (except allowed files)
      if (!ALLOWED_AS_ANY_FILES.has(filePath) && /\bas\s+any\b/.test(line)) {
        violations.push(
          `VIOLATION: ${filePath}:${lineNum} — \`as any\` detected. See docs/golden-principles.local.md #5`,
        );
      }

      // #5: No @ts-ignore or @ts-expect-error
      if (/@ts-ignore|@ts-expect-error/.test(line)) {
        violations.push(
          `VIOLATION: ${filePath}:${lineNum} — type suppression directive detected. See docs/golden-principles.local.md #5`,
        );
      }

      // #5: No empty catch blocks (checked via whole-source regex after loop)
    }

    // #5: No empty catch blocks (multi-line aware)
    const emptyCatchPattern = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gm;
    let emptyCatchMatch = emptyCatchPattern.exec(source);
    while (emptyCatchMatch !== null) {
      const catchLine = lineNumberForOffset(source, emptyCatchMatch.index);
      const key = `${filePath}:${catchLine}`;
      if (KNOWN_EMPTY_CATCHES.has(key)) {
        console.warn(`KNOWN: ${key} — empty catch block (tracked tech debt)`);
      } else {
        violations.push(
          `VIOLATION: ${filePath}:${catchLine} — empty catch block detected. See docs/golden-principles.local.md #5`,
        );
      }
      emptyCatchMatch = emptyCatchPattern.exec(source);
    }

    // #7: No catch-all filenames
    const basename = filePath.split("/").pop() ?? "";
    if (
      /^(utils|helpers|common|service)\.ts$/.test(basename) &&
      filePath.includes("/src/") &&
      !KNOWN_CATCHALL_FILES.has(filePath)
    ) {
      violations.push(
        `VIOLATION: ${filePath} — catch-all filename detected. See docs/golden-principles.local.md #7`,
      );
    }
  }

  return violations;
}

const TRACKED_DOCS = [
  "AGENTS.md",
  "packages/protocol/AGENTS.md",
  "packages/ipc/AGENTS.md",
  "packages/telemetry/AGENTS.md",
  "packages/ledger/AGENTS.md",
  "packages/llm/AGENTS.md",
  "packages/agent/AGENTS.md",
  "packages/openomni/AGENTS.md",
  "packages/coordinator/AGENTS.md",
  "packages/channels/AGENTS.md",
  "apps/server/AGENTS.md",
];

const STALE_THRESHOLD = 50; // commits since last modification

async function checkDocFreshness(): Promise<string[]> {
  const warnings: string[] = [];

  for (const docPath of TRACKED_DOCS) {
    const file = Bun.file(docPath);
    if (!(await file.exists())) {
      warnings.push(`WARNING: tracked doc missing: ${docPath}`);
      continue;
    }

    try {
      const proc = Bun.spawn({
        cmd: ["git", "log", "--oneline", `HEAD`, "--", docPath],
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const totalCommits = output.trim().split("\n").filter(Boolean).length;
      if (totalCommits === 0) {
        // File exists but has no git history (untracked or new)
        continue;
      }

      // Count commits since last modification of this file
      const lastTouchProc = Bun.spawn({
        cmd: ["git", "log", "-1", "--format=%H", "--", docPath],
        stdout: "pipe",
        stderr: "pipe",
      });

      const lastTouchHash = (await new Response(lastTouchProc.stdout).text()).trim();
      await lastTouchProc.exited;

      if (!lastTouchHash) continue;

      const sinceProc = Bun.spawn({
        cmd: ["git", "rev-list", "--count", `${lastTouchHash}..HEAD`],
        stdout: "pipe",
        stderr: "pipe",
      });

      const commitsSince = parseInt((await new Response(sinceProc.stdout).text()).trim(), 10);
      await sinceProc.exited;

      if (commitsSince >= STALE_THRESHOLD) {
        warnings.push(
          `STALE: ${docPath} — last updated ${commitsSince} commits ago (threshold: ${STALE_THRESHOLD})`,
        );
      }
    } catch {
      // git not available or other error — skip silently
    }
  }

  return warnings;
}

/**
 * Proves the layer rules discriminate, on synthetic inputs only — it reads no
 * package and writes nothing.
 *
 * `srcAllowedDeps` is the reason this exists: a rule that narrows `src/` below
 * the manifest can be deleted and every gate stays green, because the thing it
 * forbids is exactly the thing the manifest still permits. That is the shape
 * of a decorative gate, which is what this file is supposed to prevent.
 */
function selfTest(): void {
  const twoTier: PackageRule = {
    displayName: "self-test",
    packageJsonPath: "",
    packageName: "@openomni/self-test",
    allowedDeps: new Set(["@openomni/protocol", "@openomni/telemetry"]),
    srcAllowedDeps: new Set(["@openomni/protocol"]),
  };
  const oneTier: PackageRule = { ...twoTier, srcAllowedDeps: undefined };

  const cases: Array<[string, boolean]> = [
    ["manifest permits what the manifest lists", isAllowedDep(twoTier, "@openomni/telemetry")],
    [
      "src refuses what only the manifest lists",
      !isAllowedSourceDep(twoTier, "@openomni/telemetry"),
    ],
    ["src permits its own narrower set", isAllowedSourceDep(twoTier, "@openomni/protocol")],
    ["src refuses what neither lists", !isAllowedSourceDep(twoTier, "@openomni/ledger")],
    [
      "no srcAllowedDeps falls back to the manifest",
      isAllowedSourceDep(oneTier, "@openomni/telemetry"),
    ],
    ["external packages are never layered", isAllowedSourceDep(twoTier, "zod")],
    [
      "S8: a channels driver may not import the policy engine",
      isChannelsBandingViolation("packages/channels/src/discord/surface.ts", "@openomni/policy"),
    ],
    [
      "S8: channels authn (perimeter judgment) may import the policy engine",
      !isChannelsBandingViolation("packages/channels/src/authn/decision.ts", "@openomni/policy"),
    ],
    [
      "S8: drivers keep the whitelisted contract deps",
      !isChannelsBandingViolation("packages/channels/src/discord/surface.ts", "@openomni/protocol"),
    ],
    [
      "S8: the banding rule scopes to the channels package only",
      !isChannelsBandingViolation("packages/openomni/src/ingress/engine.ts", "@openomni/policy"),
    ],
    [
      "S8: a channels driver may not import the ledger",
      isChannelsBandingViolation("packages/channels/src/telegram/surface.ts", "@openomni/ledger"),
    ],
    [
      "S8: the gateway router may import the ledger",
      !isChannelsBandingViolation(
        "packages/channels/src/router/routing-resolution.ts",
        "@openomni/ledger",
      ),
    ],
    [
      "S8: the gateway router may import the policy engine",
      !isChannelsBandingViolation("packages/channels/src/router/authority.ts", "@openomni/policy"),
    ],
    [
      "S8: a driver may not relative-import into src/router/",
      isChannelsDriverRouterEdge("packages/channels/src/discord/surface.ts", "../router/index.js"),
    ],
    [
      "S8: channel-authn (driver band) may not reach the router",
      isChannelsDriverRouterEdge(
        "packages/channels/src/channel-authn.ts",
        "./router/routing-resolution.js",
      ),
    ],
    [
      "S8: the package barrel may export the router (composition surface)",
      !isChannelsDriverRouterEdge("packages/channels/src/index.ts", "./router/index.js"),
    ],
    [
      "S8: router-internal relative imports stay legal",
      !isChannelsDriverRouterEdge(
        "packages/channels/src/router/routing-execution.ts",
        "./wait/index.js",
      ),
    ],
    [
      "S8: drivers may still import the authn judgment entry",
      !isChannelsDriverRouterEdge("packages/channels/src/channel-authn.ts", "./authn/github.js"),
    ],
    [
      "S8: the router may name a perimeter ledger surface",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/wait/lifecycle.ts",
        'import { WaitStore } from "@openomni/ledger";',
      ).length === 0,
    ],
    [
      "S8: the router may not name a brain ledger surface",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/routing-resolution.ts",
        'import { Session, SurfaceKey } from "@openomni/ledger";',
      ).length === 1,
    ],
    [
      "S8: a type-only brain-surface import is still pinned",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/authority.ts",
        'import type { WorkItemStore } from "@openomni/ledger";',
      ).length === 1,
    ],
    [
      "S8: a namespace ledger import cannot bypass the surface pin",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/actor-resolver.ts",
        'import * as Ledger from "@openomni/ledger";',
      ).length === 1,
    ],
    [
      "S8: the ledger surface pin scopes to the judgment band",
      channelsRouterLedgerViolations(
        "packages/openomni/src/ingress/engine.ts",
        'import { Session } from "@openomni/ledger";',
      ).length === 0,
    ],
    [
      "S8: a dynamic ledger import cannot bypass the surface pin",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/routing-resolution.ts",
        'const ledger = await import("@openomni/ledger");',
      ).length === 1,
    ],
    [
      "S8: a require of the ledger cannot bypass the surface pin",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/actor-resolver.ts",
        'const ledger = require("@openomni/ledger");',
      ).length === 1,
    ],
    [
      "S8: a dynamic ledger SUBPATH import is pinned too",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/index.ts",
        'const s = await import("@openomni/ledger/session");',
      ).length === 1,
    ],
    [
      "S8: a brain-surface re-export cannot launder past the pin",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/index.ts",
        'export { Session } from "@openomni/ledger";',
      ).length === 1,
    ],
    [
      "S8: a perimeter-surface re-export stays legal",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/index.ts",
        'export { WaitStore } from "@openomni/ledger";',
      ).length === 0,
    ],
    [
      "S8: a wholesale ledger re-export is refused",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/index.ts",
        'export * from "@openomni/ledger";',
      ).length === 1,
    ],
    [
      "S8: the master Storage entry is not a router surface",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/routing-resolution.ts",
        'import { Storage } from "@openomni/ledger";',
      ).length === 1,
    ],
    [
      "S8: the scoped append port is the legal decision-record road",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/routing-resolution.ts",
        'import { LedgerAppend } from "@openomni/ledger";',
      ).length === 0,
    ],
  ];

  const failed = cases.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    for (const name of failed) console.error(`SELF-TEST FAILED: ${name}`);
    process.exit(1);
  }
  console.log(`OK: check-deps self-test — ${cases.length} layer discriminations hold`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (Bun.argv.includes("--self-test")) selfTest();
  const depViolations = await validateDependencyDirection();
  const sourceImportViolations = await validateSourceImportDirection();
  const channelsBandingViolations = await validateChannelsIntraPackageBanding();
  const deepImportViolations = await validateDeepImports();
  const deepRelativeImportViolations = await validateDeepRelativeImports();
  const goldenViolations = await validateGoldenPrinciples();
  const freshnessWarnings = await checkDocFreshness();
  const violations = [
    ...depViolations,
    ...sourceImportViolations,
    ...channelsBandingViolations,
    ...deepImportViolations,
    ...deepRelativeImportViolations,
    ...goldenViolations,
  ];

  // Print freshness warnings (non-blocking)
  for (const warning of freshnessWarnings) {
    console.warn(warning);
  }

  if (violations.length === 0 && freshnessWarnings.length === 0) {
    console.log(
      "OK: dependency direction, import boundaries, golden principles, and doc freshness are valid",
    );
    process.exit(0);
  }

  if (violations.length === 0 && freshnessWarnings.length > 0) {
    console.log(`OK: no violations, but ${freshnessWarnings.length} stale doc(s) detected`);
    process.exit(0);
  }

  for (const violation of violations) {
    console.error(violation);
  }

  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
