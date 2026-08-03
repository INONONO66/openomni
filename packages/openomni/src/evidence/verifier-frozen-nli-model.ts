import { createHash } from "node:crypto";

export type FrozenNliRelation = "entails" | "contradicts" | "unknown";

const FrozenSymbolicNliModel = Object.freeze({
  version: "openomni-frozen-symbolic-nli-v3",
  tokenizationVersion: "unicode-word-v1",
  claimCoverageThreshold: 1,
  maxSegments: 4096,
  negators: Object.freeze(["no", "not", "never", "without"]),
  clauseBoundaries: Object.freeze(["although", "and", "but", "however", "while"]),
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
      ["pass", "passes", "passed", "passing", "succeed", "succeeds", "succeeded", "successful"],
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
    textFeatures,
    tokenSequence,
    numbers,
    claimCoverage,
    containsOpposition,
    isContradictionToken,
    isOrderedSubsequence,
    hasScopedNegation,
  ].map((value) => value.toString()),
});
export const FrozenNliModelFingerprint = `sha256:${createHash("sha256").update(modelBytes).digest("hex")}`;

export function frozenSymbolicNliInfer(premise: string, hypothesis: string): FrozenNliRelation {
  const sourceSegments = segments(premise);
  if (sourceSegments.length > FrozenSymbolicNliModel.maxSegments) return "unknown";
  const claim = textFeatures(hypothesis);
  if (claim.tokens.size === 0) return "unknown";
  const claimAnchors = new Set(
    [...claim.words].filter(
      (token) => !FrozenSymbolicNliModel.negators.includes(token) && !isContradictionToken(token),
    ),
  );
  if (claimAnchors.size === 0) return "unknown";
  const preparedClaim = { ...claim, anchors: claimAnchors };
  let entailed = false;
  let contradicted = false;
  for (const segment of sourceSegments) {
    const relation = inferSegment(segment, preparedClaim);
    if (relation === "entails") entailed = true;
    if (relation === "contradicts") contradicted = true;
  }
  if (entailed && contradicted) return "unknown";
  if (entailed) return "entails";
  return contradicted ? "contradicts" : "unknown";
}

type TextFeatures = Readonly<{
  sequence: readonly string[];
  tokens: ReadonlySet<string>;
  words: ReadonlySet<string>;
  numbers: readonly string[];
}>;

type ClaimFeatures = TextFeatures & Readonly<{ anchors: ReadonlySet<string> }>;

function inferSegment(premise: string, claim: ClaimFeatures): FrozenNliRelation {
  const source = textFeatures(premise);
  if (claim.sequence.length > source.sequence.length) return "unknown";
  if (claim.anchors.size > source.tokens.size) return "unknown";
  if (claimCoverage(source.tokens, claim.anchors) < 1) return "unknown";
  if (containsOpposition(source.tokens, claim.tokens)) return "contradicts";
  const lexicalCoverage = claimCoverage(source.words, claim.words);
  if (lexicalCoverage < FrozenSymbolicNliModel.claimCoverageThreshold) return "unknown";
  if (!claim.numbers.every((number) => source.numbers.includes(number))) {
    return source.numbers.length === 0 ? "unknown" : "contradicts";
  }
  const sourceNegated = hasScopedNegation(source.sequence, claim.tokens);
  const claimNegated = hasScopedNegation(claim.sequence, source.tokens);
  if (sourceNegated !== claimNegated) return "contradicts";
  return isOrderedSubsequence(source.sequence, claim.sequence) ? "entails" : "unknown";
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

function textFeatures(value: string): TextFeatures {
  const sequence = tokenSequence(value);
  return {
    sequence,
    tokens: new Set(sequence),
    words: new Set(sequence.filter((token) => !/^\d+(?:\.\d+)?$/.test(token))),
    numbers: numbers(value),
  };
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
  let negated = false;
  for (const [index, token] of source.entries()) {
    if (FrozenSymbolicNliModel.clauseBoundaries.includes(token) && index > 0) {
      negated = false;
      continue;
    }
    if (FrozenSymbolicNliModel.negators.includes(token)) {
      negated = true;
      continue;
    }
    if (negated && comparedClaim.has(token)) return true;
  }
  return false;
}

function numbers(value: string): string[] {
  return value.match(/-?\d+(?:\.\d+)?/g) ?? [];
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
