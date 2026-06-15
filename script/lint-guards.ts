export {};

type GuardRuleId =
  | "ad-hoc-list-membership"
  | "inline-channel-trigger-evaluation"
  | "inline-authorization-throw"
  | "missing-canonical-policy-evaluator";

interface GuardViolation {
  readonly ruleId: GuardRuleId;
  readonly filePath: string;
  readonly line: number;
  readonly message: string;
}

interface SourceMatch {
  readonly index: number;
  readonly text: string;
}

const scanRoots = ["packages", "apps"];
const excludedPathParts = ["/dist/", "/node_modules/", "/coverage/", "/generated/"];
const excludedSuffixes = [".d.ts", ".generated.ts", ".gen.ts"];

// Only the private policy permission leaf may implement raw allowlist/denylist membership;
// every public caller still routes through Policy.evaluate.
const canonicalPolicyEvaluator = new Set(["packages/protocol/src/policy/permission.ts"]);
const canonicalPolicyRequiredFiles = new Set([
  "packages/openomni/src/ingress/middleware/ingress-authority-evaluation.ts",
  "packages/openomni/src/subagent/middleware/subagent-spawn-policy.ts",
  "packages/openomni/src/subagent/middleware/background-limits.ts",
  "packages/agent/src/core/policy/builtin/messenger-allow-pattern.ts",
  "apps/server/src/tool/mcp/mcp-prefix-guard.ts",
  "apps/server/src/channel/authn/decision.ts",
]);
const approvedAuthorizationFiles = new Set([
  "packages/openomni/src/extension/manager.ts",
  "packages/coordinator/src/tool-permission/policy.ts",
]);

const listMembershipPattern = /\b(?:denylist|allowlist)\s*\??\.\s*includes\s*\(/g;
const channelNormalizerTriggerPattern = /\bevaluateTriggers\s*\(/g;
const inlineAuthorizationThrowPatterns = [
  /if\s*\(\s*!\s*(?:[\w$]+\.)*(?:isAuthorized|authorized|hasAuthority|hasPermission|isAllowed|canAuthorize)(?:\s*\([^)]*\))?\s*\)\s*(?:\{\s*)?throw\b/gi,
  /if\s*\(\s*(?:[\w$]+\.)*(?:isAuthorized|authorized|hasAuthority|hasPermission|isAllowed|canAuthorize)\s*(?:===\s*false|!==\s*true)\s*\)\s*(?:\{\s*)?throw\b/gi,
];

async function main(): Promise<void> {
  const files = await collectSourceFiles();
  const violations: GuardViolation[] = [];

  for (const filePath of files) {
    const source = await Bun.file(filePath).text();
    violations.push(...validateCanonicalPolicyUsage(filePath, source));
    violations.push(...validateChannelTriggerEvaluation(filePath, source));
    violations.push(...validateListMembership(filePath, source));
    violations.push(...validateInlineAuthorization(filePath, source));
  }

  if (violations.length === 0) {
    process.stdout.write(`OK: guard lint scanned ${files.length} TypeScript files\n`);
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `VIOLATION: ${violation.filePath}:${violation.line} [${violation.ruleId}] — ${violation.message}\n`,
    );
  }

  process.exit(1);
}

async function collectSourceFiles(): Promise<string[]> {
  const files = new Set<string>();

  for (const root of scanRoots) {
    const glob = new Bun.Glob(`${root}/**/*.ts`);
    for await (const filePath of glob.scan({
      cwd: ".",
      absolute: false,
      dot: false,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      if (!shouldSkip(filePath)) {
        files.add(filePath);
      }
    }
  }

  return Array.from(files).sort((left, right) => left.localeCompare(right));
}

function shouldSkip(filePath: string): boolean {
  if (excludedSuffixes.some((suffix) => filePath.endsWith(suffix))) {
    return true;
  }

  return excludedPathParts.some((part) => filePath.includes(part));
}

function validateCanonicalPolicyUsage(filePath: string, source: string): GuardViolation[] {
  if (!canonicalPolicyRequiredFiles.has(filePath) || source.includes("Policy.evaluate(")) {
    return [];
  }

  return [
    {
      ruleId: "missing-canonical-policy-evaluator",
      filePath,
      line: 1,
      message: "migrated policy middleware must route permission verdicts through Policy.evaluate",
    },
  ];
}

function validateChannelTriggerEvaluation(filePath: string, source: string): GuardViolation[] {
  if (!filePath.startsWith("apps/server/src/channel/") || !filePath.endsWith("/normalizer.ts")) {
    return [];
  }

  return matches(source, channelNormalizerTriggerPattern).map((match) => ({
    ruleId: "inline-channel-trigger-evaluation",
    filePath,
    line: lineNumberForOffset(source, match.index),
    message: "channel normalizers must leave trigger authorization to channel-authn middleware",
  }));
}

function validateListMembership(filePath: string, source: string): GuardViolation[] {
  if (canonicalPolicyEvaluator.has(filePath)) {
    return [];
  }

  return matches(source, listMembershipPattern).map((match) => ({
    ruleId: "ad-hoc-list-membership",
    filePath,
    line: lineNumberForOffset(source, match.index),
    message:
      "denylist/allowlist membership must go through Policy.evaluate instead of inline includes",
  }));
}

function validateInlineAuthorization(filePath: string, source: string): GuardViolation[] {
  if (approvedAuthorizationFiles.has(filePath)) {
    return [];
  }

  return inlineAuthorizationThrowPatterns.flatMap((pattern) =>
    matches(source, pattern).map((match) => ({
      ruleId: "inline-authorization-throw",
      filePath,
      line: lineNumberForOffset(source, match.index),
      message:
        "inline authorization throws belong in approved middleware or policy implementation files",
    })),
  );
}

function matches(source: string, pattern: RegExp): SourceMatch[] {
  pattern.lastIndex = 0;
  const results: SourceMatch[] = [];

  let match = pattern.exec(source);
  while (match !== null) {
    results.push({ index: match.index, text: match[0] });
    match = pattern.exec(source);
  }

  return results;
}

function lineNumberForOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
});
