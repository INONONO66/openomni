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
  Glob: new (pattern: string) => {
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

type PackageKey = "protocol" | "session" | "llm" | "agent" | "openomni" | "cli";

type PackageRule = {
  displayName: string;
  packageJsonPath: string;
  packageName: string;
  allowedDeps: "none" | "any-except-self" | Set<string>;
};

const SHOW_FIX_SUGGESTIONS = Bun.argv.includes("--fix-suggestions");

// Known deep import violations (tracked tech debt — do not extend)
// These are excluded from CI failure to avoid blocking unrelated PRs.
const KNOWN_DEEP_IMPORT_FILES = new Set([
  "apps/cli/src/cmd/auth.ts", // #33 tech debt: imports @openomni/llm internals
]);

const RULES: Record<PackageKey, PackageRule> = {
  protocol: {
    displayName: "protocol",
    packageJsonPath: "packages/protocol/package.json",
    packageName: "@openomni/protocol",
    allowedDeps: "none",
  },
  session: {
    displayName: "session",
    packageJsonPath: "packages/session/package.json",
    packageName: "@openomni/session",
    allowedDeps: new Set(["@openomni/protocol"]),
  },
  llm: {
    displayName: "llm",
    packageJsonPath: "packages/llm/package.json",
    packageName: "@openomni/llm",
    allowedDeps: new Set(["@openomni/protocol", "@openomni/session"]),
  },
  agent: {
    displayName: "agent",
    packageJsonPath: "packages/agent/package.json",
    packageName: "@openomni/agent",
    allowedDeps: new Set([
      "@openomni/protocol",
      "@openomni/llm",
    ]),
  },
  openomni: {
    displayName: "openomni",
    packageJsonPath: "packages/openomni/package.json",
    packageName: "@openomni/openomni",
    allowedDeps: "any-except-self",
  },
  cli: {
    displayName: "cli",
    packageJsonPath: "apps/cli/package.json",
    packageName: "@openomni/cli",
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
  if (
    path.includes("/test/") ||
    path.includes("/tests/") ||
    path.includes("/__tests__/")
  ) {
    return true;
  }

  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".spec.ts") ||
    path.endsWith(".test.tsx") ||
    path.endsWith(".spec.tsx")
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
    if (
      filePath.includes("/node_modules/") ||
      filePath.startsWith("node_modules/") ||
      filePath.includes("/dist/") ||
      filePath.startsWith("dist/") ||
      isTestFile(filePath) ||
      filePath.startsWith("script/")
    ) {
      continue;
    }

    const source = await Bun.file(filePath).text();
    importPattern.lastIndex = 0;

    let match: RegExpExecArray | null = null;
    while ((match = importPattern.exec(source)) !== null) {
      const importPath = match[1];
      const line = lineNumberForOffset(source, match.index);
      const isKnown = KNOWN_DEEP_IMPORT_FILES.has(filePath);
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

// --- Document Freshness Check ---

const TRACKED_DOCS = [
  "AGENTS.md",
  "packages/protocol/AGENTS.md",
  "packages/session/AGENTS.md",
  "packages/llm/AGENTS.md",
  "packages/agent/AGENTS.md",
  "packages/openomni/AGENTS.md",
  "docs/golden-principles.md",
  "docs/quality-score.md",
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
  const deepImportViolations = await validateDeepImports();
  const freshnessWarnings = await checkDocFreshness();
  const violations = [...depViolations, ...deepImportViolations];

  // Print freshness warnings (non-blocking)
  for (const warning of freshnessWarnings) {
    console.warn(warning);
  }

  if (violations.length === 0 && freshnessWarnings.length === 0) {
    console.log("OK: dependency direction, package boundaries, and doc freshness are valid");
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
