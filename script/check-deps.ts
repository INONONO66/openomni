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
      "@openomni/session",
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

async function main(): Promise<void> {
  const depViolations = await validateDependencyDirection();
  const deepImportViolations = await validateDeepImports();
  const violations = [...depViolations, ...deepImportViolations];

  if (violations.length === 0) {
    console.log("OK: dependency direction and package boundaries are valid");
    Bun.exit(0);
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
