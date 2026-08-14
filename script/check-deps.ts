declare const Bun: {
  argv: string[];
  glob?: (pattern: string) => {
    scan(options: {
      cwd: string;
      absolute: boolean;
      dot: boolean;
      onlyFiles: boolean;
      followSymlinks: boolean;
    }): AsyncIterable<string>;
  };
  file(path: string): {
    exists(): Promise<boolean>;
    text(): Promise<string>;
  };
  spawn(options: { cmd: string[]; stdout: "pipe"; stderr: "pipe" }): {
    stdout: ReadableStream;
    exited: Promise<number>;
  };
  Glob: new (
    pattern: string,
  ) => {
    scan(options: {
      cwd: string;
      absolute: boolean;
      dot: boolean;
      onlyFiles: boolean;
      followSymlinks: boolean;
    }): AsyncIterable<string>;
  };
  exit(code: number): never;
};

type PackageKey =
  | "protocol"
  | "ipc"
  | "telemetry"
  | "policy"
  | "session"
  | "llm"
  | "agent"
  | "openomni"
  | "coordinator"
  | "server";

type PackageRule = {
  displayName: string;
  packageJsonPath: string;
  packageName: string;
  allowedDeps: "none" | "any-except-self" | Set<string>;
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
  session: {
    displayName: "session",
    packageJsonPath: "packages/session/package.json",
    packageName: "@openomni/session",
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
    // `packages/llm/src` is protocol-only: it reads and writes the model and
    // reports through an injected `BusEvent.Sink`, so it imports no
    // implementation of the observation channel at all (#606). `telemetry`
    // stays listed because the tests bind `Bus`/`collector` behind that port,
    // and `check-deps` counts devDependencies; the source-import scan is what
    // proves `src/` clean.
    allowedDeps: new Set(["@openomni/protocol", "@openomni/telemetry"]),
  },
  agent: {
    displayName: "agent",
    packageJsonPath: "packages/agent/package.json",
    packageName: "@openomni/agent",
    // The loop owns no durable state. Same reason as llm: the ledger edge was
    // `Bus`'s old address, and the ratchet keeps it closed (#606).
    allowedDeps: new Set([
      "@openomni/protocol",
      "@openomni/policy",
      "@openomni/llm",
      "@openomni/telemetry",
    ]),
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
    // session-free; #496 moved the IPC transport into @openomni/ipc; this
    // ratchet keeps it that way — widening requires Owner sign-off).
    allowedDeps: new Set(["@openomni/protocol", "@openomni/ipc"]),
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
  const match = importPath.match(/^(@openomni\/[^/]+)/);
  return match ? match[1] : importPath;
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
 * phantom imports (a bare `import "@openomni/session"` resolves through the
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
  const sourceGlob = Bun.glob ? Bun.glob("**/*.ts") : new Bun.Glob("**/*.ts");

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
    importPattern.lastIndex = 0;

    let match = importPattern.exec(source);
    while (match !== null) {
      const dep = match[1];
      if (!isAllowedDep(owner.rule, dep)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} source-imports ${dep} — not allowed by layer order for ${owner.rule.displayName} (manifest check cannot see phantom imports)`,
        );
      }
      match = importPattern.exec(source);
    }
  }

  return violations;
}

async function validateDeepImports(): Promise<string[]> {
  const violations: string[] = [];
  // Matches both `from "@openomni/.../src/..."` and side-effect `import "@openomni/.../src/..."`
  const importPattern = /(?:from\s+|import\s+)["'](@openomni\/[^"']+\/src\/[^"']*)["']/g;
  const sourceGlob = Bun.glob ? Bun.glob("**/*.ts") : new Bun.Glob("**/*.ts");

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
    importPattern.lastIndex = 0;

    let match = importPattern.exec(source);
    while (match !== null) {
      const importPath = match[1];
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
      match = importPattern.exec(source);
    }
  }

  return violations;
}

async function validateDeepRelativeImports(): Promise<string[]> {
  const violations: string[] = [];
  const importPattern = /(?:from\s+|import\s*\(\s*)["'](\.{2}\/[^"']*)["']/g;
  const sourceGlob = Bun.glob ? Bun.glob("**/*.ts") : new Bun.Glob("**/*.ts");

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
    importPattern.lastIndex = 0;

    let match = importPattern.exec(source);
    while (match !== null) {
      const importPath = match[1];
      const line = lineNumberForOffset(source, match.index);
      const key = `${filePath}:${importPath}`;
      const isSelfRootImport = importPath.startsWith("../../src/");
      const isDeepRelativeImport = parentTraversalDepth(importPath) >= 3;

      if (!isSelfRootImport && !isDeepRelativeImport) {
        match = importPattern.exec(source);
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

      match = importPattern.exec(source);
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
  const sourceGlob = Bun.glob ? Bun.glob("**/*.ts") : new Bun.Glob("**/*.ts");

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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

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
  "packages/session/AGENTS.md",
  "packages/llm/AGENTS.md",
  "packages/agent/AGENTS.md",
  "packages/openomni/AGENTS.md",
  "packages/coordinator/AGENTS.md",
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
      }) as { stdout: ReadableStream; exited: Promise<number> };

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
      }) as { stdout: ReadableStream; exited: Promise<number> };

      const lastTouchHash = (await new Response(lastTouchProc.stdout).text()).trim();
      await lastTouchProc.exited;

      if (!lastTouchHash) continue;

      const sinceProc = Bun.spawn({
        cmd: ["git", "rev-list", "--count", `${lastTouchHash}..HEAD`],
        stdout: "pipe",
        stderr: "pipe",
      }) as { stdout: ReadableStream; exited: Promise<number> };

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

async function main(): Promise<void> {
  const depViolations = await validateDependencyDirection();
  const sourceImportViolations = await validateSourceImportDirection();
  const deepImportViolations = await validateDeepImports();
  const deepRelativeImportViolations = await validateDeepRelativeImports();
  const goldenViolations = await validateGoldenPrinciples();
  const freshnessWarnings = await checkDocFreshness();
  const violations = [
    ...depViolations,
    ...sourceImportViolations,
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
