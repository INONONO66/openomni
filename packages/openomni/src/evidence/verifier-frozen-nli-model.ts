import { createHash } from "node:crypto";

export type FrozenNliRelation = "entails" | "contradicts" | "unknown";

const FrozenSymbolicNliModel = Object.freeze({
  version: "openomni-frozen-symbolic-nli-v2",
  tokenizationVersion: "unicode-word-v1",
  claimCoverageThreshold: 1,
  negators: Object.freeze(["no", "not", "never", "without"]),
  contradictionGroups: Object.freeze([
    pair(
      ["increase", "increases", "increased", "increasing"],
      ["decrease", "decreases", "decreased", "decreasing"],
    ),
    pair(["present"], ["absent"]),
    pair(
      ["accept", "accepts", "accepted", "accepting"],
      ["reject", "rejects", "rejected", "rejecting"],
    ),
    pair(["allow", "allows", "allowed", "allowing"], ["deny", "denies", "denied", "denying"]),
    pair(["win", "wins", "won", "winning"], ["lose", "loses", "lost", "losing"]),
    pair(
      ["succeed", "succeeds", "succeeded", "successful"],
      ["fail", "fails", "failed", "failure"],
    ),
    pair(["true"], ["false"]),
    pair(["before"], ["after"]),
  ]),
});

const modelBytes = JSON.stringify({
  asset: FrozenSymbolicNliModel,
  executable: [
    frozenSymbolicNliInfer,
    inferSegment,
    segments,
    tokenSequence,
    tokens,
    numbers,
    wordTokens,
    claimCoverage,
    containsOpposition,
    isContradictionToken,
    isOrderedSubsequence,
    hasScopedNegation,
  ].map((value) => value.toString()),
});
export const FrozenNliModelFingerprint = `sha256:${createHash("sha256").update(modelBytes).digest("hex")}`;

export function frozenSymbolicNliInfer(premise: string, hypothesis: string): FrozenNliRelation {
  let contradicted = false;
  for (const segment of segments(premise)) {
    const relation = inferSegment(segment, hypothesis);
    if (relation === "entails") return "entails";
    if (relation === "contradicts") contradicted = true;
  }
  return contradicted ? "contradicts" : "unknown";
}

function inferSegment(premise: string, hypothesis: string): FrozenNliRelation {
  const sourceTokens = tokens(premise);
  const claimTokens = tokens(hypothesis);
  if (claimTokens.size === 0) return "unknown";
  const claimAnchors = new Set(
    [...wordTokens(hypothesis)].filter(
      (token) => !FrozenSymbolicNliModel.negators.includes(token) && !isContradictionToken(token),
    ),
  );
  if (claimAnchors.size === 0) return "unknown";
  if (claimCoverage(sourceTokens, claimAnchors) < 1) return "unknown";
  if (containsOpposition(sourceTokens, claimTokens)) return "contradicts";
  const lexicalCoverage = claimCoverage(wordTokens(premise), wordTokens(hypothesis));
  if (lexicalCoverage < FrozenSymbolicNliModel.claimCoverageThreshold) return "unknown";
  const sourceNumbers = numbers(premise);
  const claimNumbers = numbers(hypothesis);
  if (!claimNumbers.every((number) => sourceNumbers.includes(number))) {
    return sourceNumbers.length === 0 ? "unknown" : "contradicts";
  }
  const sourceNegated = hasScopedNegation(tokenSequence(premise), claimTokens);
  const claimNegated = hasScopedNegation(tokenSequence(hypothesis), sourceTokens);
  if (sourceNegated !== claimNegated) return "contradicts";
  return isOrderedSubsequence(tokenSequence(premise), tokenSequence(hypothesis))
    ? "entails"
    : "unknown";
}

function segments(value: string): readonly string[] {
  const split = value
    .split(/(?:[!?;]\s+|\.\s+|\n+)/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return split.length === 0 ? [value] : split;
}

function pair(
  left: readonly string[],
  right: readonly string[],
): readonly [readonly string[], readonly string[]] {
  return Object.freeze([Object.freeze(left), Object.freeze(right)]);
}

function tokens(value: string): Set<string> {
  return new Set(tokenSequence(value));
}

function tokenSequence(value: string): readonly string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isOrderedSubsequence(source: readonly string[], claim: readonly string[]): boolean {
  let claimIndex = 0;
  for (const token of source) {
    if (token === claim[claimIndex]) claimIndex += 1;
    if (claimIndex === claim.length) return true;
  }
  return claim.length === 0;
}

function hasScopedNegation(source: readonly string[], comparedClaim: ReadonlySet<string>): boolean {
  for (const [index, token] of source.entries()) {
    if (!FrozenSymbolicNliModel.negators.includes(token)) continue;
    for (const scopedToken of source.slice(index + 1, index + 4)) {
      if (comparedClaim.has(scopedToken)) return true;
    }
  }
  return false;
}

function numbers(value: string): string[] {
  return value.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

function wordTokens(value: string): Set<string> {
  return new Set([...tokens(value)].filter((token) => !/^\d+(?:\.\d+)?$/.test(token)));
}

function claimCoverage(source: ReadonlySet<string>, claim: ReadonlySet<string>): number {
  let intersection = 0;
  for (const token of claim) if (source.has(token)) intersection += 1;
  return intersection / claim.size;
}

function containsOpposition(source: ReadonlySet<string>, claim: ReadonlySet<string>): boolean {
  for (const [left, right] of FrozenSymbolicNliModel.contradictionGroups) {
    const sourceLeft = left.some((word) => source.has(word));
    const sourceRight = right.some((word) => source.has(word));
    const claimLeft = left.some((word) => claim.has(word));
    const claimRight = right.some((word) => claim.has(word));
    if ((sourceLeft && claimRight) || (sourceRight && claimLeft)) return true;
  }
  return false;
}

function isContradictionToken(token: string): boolean {
  return FrozenSymbolicNliModel.contradictionGroups.some(([left, right]) =>
    [...left, ...right].includes(token),
  );
}
