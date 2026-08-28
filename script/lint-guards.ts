import { Policy } from "../packages/protocol/src/index";

type GuardRuleId =
  | "ad-hoc-list-membership"
  | "inline-channel-trigger-evaluation"
  | "inline-authorization-throw"
  | "missing-canonical-policy-evaluator"
  | "policy-package-boundary"
  | "run-reason-code-vocabulary"
  | "policy-point-registration";

interface GuardViolation {
  readonly ruleId: GuardRuleId;
  readonly filePath: string;
  readonly line: number;
  readonly message: string;
}

interface SourceMatch {
  readonly index: number;
  readonly text: string;
  readonly captured?: string;
}

const scanRoots = ["packages", "apps"];
const excludedPathParts = ["/dist/", "/node_modules/", "/coverage/", "/generated/"];
const excludedSuffixes = [".d.ts", ".generated.ts", ".gen.ts"];

// Only the canonical permission evaluator leaf may implement raw allowlist/denylist
// membership; every public caller still routes through evaluatePermission
// (@openomni/policy, the engine's owner since #498 W1).
const canonicalPolicyEvaluator = new Set(["packages/policy/src/permission-evaluate.ts"]);
const canonicalPolicyRequiredFiles = new Set([
  "packages/channels/src/router/authority.ts",
  "packages/channels/src/authn/decision.ts",
]);
const approvedAuthorizationFiles = new Set<string>([]);

const listMembershipPattern = /\b(?:denylist|allowlist)\s*\??\.\s*includes\s*\(/g;
const channelNormalizerTriggerPattern = /\bevaluateTriggers\s*\(/g;
const inlineAuthorizationThrowPatterns = [
  /if\s*\(\s*!\s*(?:[\w$]+\.)*(?:isAuthorized|authorized|hasAuthority|hasPermission|isAllowed|canAuthorize)(?:\s*\([^)]*\))?\s*\)\s*(?:\{\s*)?throw\b/gi,
  /if\s*\(\s*(?:[\w$]+\.)*(?:isAuthorized|authorized|hasAuthority|hasPermission|isAllowed|canAuthorize)\s*(?:===\s*false|!==\s*true)\s*\)\s*(?:\{\s*)?throw\b/gi,
];
/**
 * The run loop's closed reason-code vocabulary, declared once in
 * `packages/agent/src/core/policy/reason-codes.ts` and produced from another
 * package, so a literal at the producer is a coupling the compiler cannot see:
 * rename one end and the loop silently stops reacting.
 *
 * Scoped to shipped source, at the two positions a rename starts: producers
 * (`reasonCodes:` arrays) and consumers (equality or `.includes` against one
 * of the values). Deliberately NOT matched elsewhere: `"stalled"` is also a
 * value of the unrelated `AgentResult.finishReason` union, and a test that
 * asserts the literal is the pin proving the constant's value — routing those
 * through the constant would make them pass no matter what it became. A code
 * reaching a `reasonCodes` array through a variable or helper parameter is
 * also out of reach; the test pins are the layer that catches a wrong value.
 */
const runReasonCodeSource = "packages/agent/src/core/policy/reason-codes.ts";
const runReasonCodeLiteralPattern =
  /reasonCodes:\s*\[[^\]]*?["'`](stalled|budget_warning|budget_reassurance)["'`]/g;
const runReasonCodeComparisonPattern =
  /(?:[!=]==\s*|\.includes\()["'`](stalled|budget_warning|budget_reassurance)["'`]/g;

/**
 * Policy points the engine dispatches at but nothing in shipped source
 * registers a policy for — dispatch runs, collects no opinions, allows.
 * That is a legitimate state for an extension point, but reaching it by
 * losing a registration is a silent behavioral regression: the policy
 * stops running and every suite that doesn't exercise the full product
 * wiring stays green. So the zero-registration set is pinned both ways —
 * a point leaving it means this list is stale; a point entering it means
 * a registration was lost (or must be acknowledged here, in review).
 *
 * This counts registration *sites* (`pointIds:` literals under `/src/`),
 * not live wiring — a site that exists but is never reached is out of a
 * static guard's reach.
 */
const policyPointsWithoutProductionRegistration = new Set([
  "connection.llm.pre",
  "connection.llm.post",
  "delegation.worker.pre",
  "delegation.worker.post",
  "dispatch.action.pre",
  "prompt.context.pre",
  "run.completion.pre",
  "run.error.error",
  "run.lifecycle.pre",
  "run.lifecycle.post",
  "run.turn.pre",
  "run.turn.post",
  "tool.catalog.pre",
  "tool.mcp.pre",
  "tool.mcp.post",
  "tool.native.pre",
  "tool.native.post",
  "work.complete.pre",
]);
const pointIdsArrayPattern = /\bpointIds:\s*\[([^\]]*)\]/g;
const pointIdLiteralPattern = /["'`]([a-z][a-z._]+)["'`]/g;

const policyPackageBoundaryPattern =
  /(?:from\s+|import\s+)["'](@openomni\/(?:agent|ledger))[^"']*["']/g;

/**
 * File-path allowlists go silently vacuous when a scanned file is renamed or
 * deleted: `missing-canonical-policy-evaluator` only fires for a path in
 * `canonicalPolicyRequiredFiles`, so a rename removes the file from the set's
 * reach and the rule stops checking it with no signal. Assert every pinned
 * path exists so a rename fails loud here instead (mirrors
 * lint-side-effects.ts's "Missing hot file" guard).
 */
async function verifyPinnedFilesExist(): Promise<void> {
  const pinned = [
    ...canonicalPolicyEvaluator,
    ...canonicalPolicyRequiredFiles,
    ...approvedAuthorizationFiles,
  ];
  for (const filePath of pinned) {
    if (!(await Bun.file(filePath).exists())) {
      throw new Error(
        `Missing pinned guard file: ${filePath} — a rule that keys off this path would silently go vacuous; update lint-guards.ts if the rename/deletion is intentional`,
      );
    }
  }
}

async function main(): Promise<void> {
  await verifyPinnedFilesExist();
  const files = await collectSourceFiles();
  const violations: GuardViolation[] = [];

  const registeredPoints = new Map<string, string>();
  for (const filePath of files) {
    const source = await Bun.file(filePath).text();
    collectPolicyPointRegistrations(filePath, source, registeredPoints);
    violations.push(...validateCanonicalPolicyUsage(filePath, source));
    violations.push(...validateChannelTriggerEvaluation(filePath, source));
    violations.push(...validateListMembership(filePath, source));
    violations.push(...validateInlineAuthorization(filePath, source));
    violations.push(...validatePolicyPackageBoundary(filePath, source));
    violations.push(...validateRunReasonCodeVocabulary(filePath, source));
  }

  violations.push(...validatePolicyPointRegistrations(registeredPoints));

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
  if (!canonicalPolicyRequiredFiles.has(filePath) || source.includes("evaluatePermission(")) {
    return [];
  }

  return [
    {
      ruleId: "missing-canonical-policy-evaluator",
      filePath,
      line: 1,
      message:
        "migrated policy middleware must route permission verdicts through evaluatePermission",
    },
  ];
}

function validateChannelTriggerEvaluation(filePath: string, source: string): GuardViolation[] {
  if (!filePath.startsWith("packages/channels/src/") || !filePath.endsWith("/normalizer.ts")) {
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
      "denylist/allowlist membership must go through evaluatePermission instead of inline includes",
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

function validatePolicyPackageBoundary(filePath: string, source: string): GuardViolation[] {
  if (!filePath.startsWith("packages/policy/src/")) {
    return [];
  }

  return matches(source, policyPackageBoundaryPattern).map((match) => ({
    ruleId: "policy-package-boundary",
    filePath,
    line: lineNumberForOffset(source, match.index),
    message: "packages/policy must not import from @openomni/agent or @openomni/ledger",
  }));
}

function validateRunReasonCodeVocabulary(filePath: string, source: string): GuardViolation[] {
  if (filePath === runReasonCodeSource || !filePath.includes("/src/")) return [];

  return [
    ...matches(source, runReasonCodeLiteralPattern),
    ...matches(source, runReasonCodeComparisonPattern),
  ].map((match) => ({
    filePath,
    line: lineNumberForOffset(source, match.index),
    ruleId: "run-reason-code-vocabulary",
    message: `run reason code "${match.captured}" written as a literal; use RunReasonCode from @openomni/agent so a rename fails the build instead of the run loop`,
  }));
}

function collectPolicyPointRegistrations(
  filePath: string,
  source: string,
  registeredPoints: Map<string, string>,
): void {
  if (!filePath.includes("/src/")) return;

  for (const arrayMatch of matches(source, pointIdsArrayPattern)) {
    for (const idMatch of matches(arrayMatch.captured ?? "", pointIdLiteralPattern)) {
      const pointId = idMatch.captured ?? "";
      if (!registeredPoints.has(pointId)) registeredPoints.set(pointId, filePath);
    }
  }
}

function validatePolicyPointRegistrations(registeredPoints: Map<string, string>): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const pointId of Object.keys(Policy.PolicyPoint.Registry)) {
    const registeredAt = registeredPoints.get(pointId);
    const allowlisted = policyPointsWithoutProductionRegistration.has(pointId);
    if (registeredAt === undefined && !allowlisted) {
      violations.push({
        filePath: "script/lint-guards.ts",
        line: 0,
        ruleId: "policy-point-registration",
        message: `policy point "${pointId}" has no production registration site left — a policy silently stopped running, or acknowledge the empty point in policyPointsWithoutProductionRegistration`,
      });
    }
    if (registeredAt !== undefined && allowlisted) {
      violations.push({
        filePath: registeredAt,
        line: 0,
        ruleId: "policy-point-registration",
        message: `policy point "${pointId}" is registered here but still listed in policyPointsWithoutProductionRegistration — remove the stale allowlist entry`,
      });
    }
  }

  return violations;
}

function matches(source: string, pattern: RegExp): SourceMatch[] {
  pattern.lastIndex = 0;
  const results: SourceMatch[] = [];

  let match = pattern.exec(source);
  while (match !== null) {
    results.push({ index: match.index, text: match[0], captured: match[1] });
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
