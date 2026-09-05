import { Glob } from "bun";
import { assertTopologyComplete, TOPOLOGY, type WorkspaceTopology } from "./topology";

type PackageRule = {
  displayName: string;
  packageJsonPath: string;
  packageName: string;
  allowedDeps: "none" | "any-except-self" | Set<string>;
  srcAllowedDeps?: Set<string>;
};

const SHOW_FIX_SUGGESTIONS = Bun.argv.includes("--fix-suggestions");

/** Barrel-only cross-package import specifier, shared by both direction checks. */
const openomniBarrelImportPattern = () =>
  /(?:from\s+|import\s+|import\s*\(\s*)["'](@openomni\/[^"'/]+)(?:\/[^"']*)?["']/g;

const RULES = Object.fromEntries(
  TOPOLOGY.map((workspace: WorkspaceTopology) => [
    workspace.key,
    {
      displayName: workspace.displayName,
      packageJsonPath: `${workspace.dir}/package.json`,
      packageName: workspace.packageName,
      allowedDeps:
        typeof workspace.allowedDeps === "string"
          ? workspace.allowedDeps
          : new Set<string>(workspace.allowedDeps),
      srcAllowedDeps:
        workspace.srcAllowedDeps === undefined
          ? undefined
          : new Set<string>(workspace.srcAllowedDeps),
    },
  ]),
) as Record<string, PackageRule>;

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

type ScannedSource = { filePath: string; source: string };

/**
 * Single owner of repository source traversal: one glob walk, one exclusion
 * rule, one read. Every validator below consumes this instead of repeating the
 * scan options.
 */
async function* scanRepositorySources(pattern: string): AsyncGenerator<ScannedSource> {
  const sourceGlob = new Glob(pattern);

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

    yield { filePath, source: await Bun.file(filePath).text() };
  }
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
  const importPattern = openomniBarrelImportPattern();

  for await (const { filePath, source } of scanRepositorySources("**/*.ts")) {
    const owner = owners.find(({ srcPrefix }) => filePath.startsWith(srcPrefix));
    if (!owner) continue;

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
 * channel grants, waits, the surface↔session map, and the SCOPED append
 * port (append + headFact — never the master
 * `Storage` entry, whose adapter reaches every brain surface). Brain
 * surfaces (Session, transcript, artifact, worker-run/grant,
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
  "LedgerAppend",
  // #219 active-egress debit ledger — a perimeter surface written ONLY by the
  // router's send kernel (same isolation as the wait store; brain never reaches it).
  "EgressBudgetStore",
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
  // driver — it is how apps/openomni reaches createGatewayRouter.
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
  const importPattern = openomniBarrelImportPattern();
  const relativeImportPattern = /(?:from\s+|import\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g;

  for await (const { filePath, source } of scanRepositorySources(
    `${CHANNELS_SRC_PREFIX}**/*.ts`,
  )) {
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
  const importPattern =
    /(?:from\s+|import\s+|import\s*\(\s*)["'](@openomni\/[^"']+\/src\/[^"']*)["']/g;

  for await (const { filePath, source } of scanRepositorySources("**/*.ts")) {
    for (const match of source.matchAll(importPattern)) {
      const importPath = match[1] as string;
      const line = lineNumberForOffset(source, match.index);
      const base = `VIOLATION: ${filePath}:${line} imports ${importPath} — use package barrel instead`;

      if (SHOW_FIX_SUGGESTIONS) {
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

  for await (const { filePath, source } of scanRepositorySources("**/*.ts")) {
    for (const match of source.matchAll(importPattern)) {
      const importPath = match[1] as string;
      const line = lineNumberForOffset(source, match.index);
      const isSelfRootImport = importPath.startsWith("../../src/");
      const isDeepRelativeImport = parentTraversalDepth(importPath) >= 3;

      if (!isSelfRootImport && !isDeepRelativeImport) {
        continue;
      }

      const reason = isSelfRootImport ? "self-root relative import" : "deep relative import";
      violations.push(
        `VIOLATION: ${filePath}:${line} imports ${importPath} — ${reason}; use a closer relative import or a domain barrel`,
      );
    }
  }

  return violations;
}

// See docs/golden-principles.local.md for the full list.

async function validateGoldenPrinciples(): Promise<string[]> {
  const violations: string[] = [];

  for await (const { filePath, source } of scanRepositorySources("**/*.ts")) {
    const lines = source.split("\n");

    for (const [index, line] of lines.entries()) {
      const lineNum = index + 1;

      // #5: No `as any`
      if (/\bas\s+any\b/.test(line)) {
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
      violations.push(
        `VIOLATION: ${filePath}:${catchLine} — empty catch block detected. See docs/golden-principles.local.md #5`,
      );
      emptyCatchMatch = emptyCatchPattern.exec(source);
    }

    // #7: No catch-all filenames
    const basename = filePath.split("/").pop() ?? "";
    if (/^(utils|helpers|common|service)\.ts$/.test(basename) && filePath.includes("/src/")) {
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
  "packages/ledger/AGENTS.md",
  "packages/llm/AGENTS.md",
  "packages/agent/AGENTS.md",
  "packages/placement/AGENTS.md",
  "packages/channels/AGENTS.md",
];

const STALE_THRESHOLD = 50; // commits since last modification

async function gitOutput(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || "no stderr"}`);
  }
  return stdout;
}

async function checkDocFreshness(): Promise<string[]> {
  const warnings: string[] = [];

  for (const docPath of TRACKED_DOCS) {
    const file = Bun.file(docPath);
    if (!(await file.exists())) {
      warnings.push(`WARNING: tracked doc missing: ${docPath}`);
      continue;
    }

    try {
      // Empty hash means no git history (untracked or new file).
      const lastTouchHash = (await gitOutput(["log", "-1", "--format=%H", "--", docPath])).trim();
      if (!lastTouchHash) continue;

      const commitsSince = Number.parseInt(
        (await gitOutput(["rev-list", "--count", `${lastTouchHash}..HEAD`])).trim(),
        10,
      );

      if (commitsSince >= STALE_THRESHOLD) {
        warnings.push(
          `STALE: ${docPath} — last updated ${commitsSince} commits ago (threshold: ${STALE_THRESHOLD})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`WARNING: doc freshness unavailable for ${docPath}: ${message}`);
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
    allowedDeps: new Set(["@openomni/protocol", "@openomni/agent"]),
    srcAllowedDeps: new Set(["@openomni/protocol"]),
  };
  const oneTier: PackageRule = { ...twoTier, srcAllowedDeps: undefined };
  const cases: Array<[string, boolean]> = [
    ["manifest permits what the manifest lists", isAllowedDep(twoTier, "@openomni/agent")],
    [
      "src refuses what only the manifest lists",
      !isAllowedSourceDep(twoTier, "@openomni/agent"),
    ],
    ["src permits its own narrower set", isAllowedSourceDep(twoTier, "@openomni/protocol")],
    ["src refuses what neither lists", !isAllowedSourceDep(twoTier, "@openomni/ledger")],
    [
      "no srcAllowedDeps falls back to the manifest",
      isAllowedSourceDep(oneTier, "@openomni/agent"),
    ],
    ["external packages are never layered", isAllowedSourceDep(twoTier, "zod")],
    [
      "S8: a channels driver may not import the policy engine",
      isChannelsBandingViolation(
        "packages/channels/src/provider/discord/surface.ts",
        "@openomni/policy",
      ),
    ],
    [
      "S8: channels authn (perimeter judgment) may import the policy engine",
      !isChannelsBandingViolation("packages/channels/src/authn/decision.ts", "@openomni/policy"),
    ],
    [
      "S8: drivers keep the whitelisted contract deps",
      !isChannelsBandingViolation(
        "packages/channels/src/provider/discord/surface.ts",
        "@openomni/protocol",
      ),
    ],
    [
      "S8: the banding rule scopes to the channels package only",
      !isChannelsBandingViolation("apps/openomni/src/gateway.ts", "@openomni/policy"),
    ],
    [
      "S8: a channels driver may not import the ledger",
      isChannelsBandingViolation(
        "packages/channels/src/provider/telegram/surface.ts",
        "@openomni/ledger",
      ),
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
      isChannelsDriverRouterEdge(
        "packages/channels/src/provider/discord/surface.ts",
        "../../router/index.js",
      ),
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
      "S8: the router may name the egress-budget perimeter surface (#219)",
      channelsRouterLedgerViolations(
        "packages/channels/src/router/messaging/send.ts",
        'import { EgressBudgetStore } from "@openomni/ledger";',
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
        `import type { ${["Transcript", "Store"].join("")} } from "@openomni/ledger";`,
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
        "apps/openomni/src/gateway.ts",
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
  assertTopologyComplete();
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

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  });
}
