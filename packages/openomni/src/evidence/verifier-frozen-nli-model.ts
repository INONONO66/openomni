import { createHash } from "node:crypto";

export type FrozenNliRelation = "entails" | "contradicts" | "unknown";

export const FrozenNliSourceDigest =
  "sha256:277d8d0693bd5f019a23600796a312fa524af30e9dd2f5604fee81c29cf6a38b";

const FrozenSymbolicNliModel = Object.freeze({
  version: "openomni-frozen-symbolic-nli-v10",
  tokenizationVersion: "unicode-word-v1",
  inferenceVersion: "punctuated-sentence-polarity-v7",
  sourceDigest: FrozenNliSourceDigest,
  claimCoverageThreshold: 1,
  maxSegments: 4096,
  negators: Object.freeze(["no", "not", "never", "without"]),
  allowedSourceModifiers: Object.freeze(["exactly"]),
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
    pair(["safe"], ["unsafe"]),
  ]),
});
const FrozenNliBehaviorProbes = Object.freeze([
  Object.freeze({
    premise: "The measured value is exactly 42 units.",
    hypothesis: "The measured value is 42 units.",
  }),
  Object.freeze({
    premise: "The measured value is exactly 99 units.",
    hypothesis: "The measured value is 42 units.",
  }),
  Object.freeze({
    premise: "Alice won the election.",
    hypothesis: "Alice lost the election.",
  }),
  Object.freeze({
    premise: "Alice told Bob that Carol won the election.",
    hypothesis: "Bob won the election.",
  }),
  Object.freeze({
    premise: "Alice did not say that Bob won the election.",
    hypothesis: "Bob won the election.",
  }),
  Object.freeze({
    premise: "The release passed all checks. The release failed all checks.",
    hypothesis: "The release passed all checks.",
  }),
  Object.freeze({
    premise: "The release did not not pass checks.",
    hypothesis: "The release did not pass checks.",
  }),
  Object.freeze({
    premise: "The dog bit the man.",
    hypothesis: "The man bit the dog.",
  }),
  Object.freeze({
    premise: "Neither Alice nor Bob won the election.",
    hypothesis: "Alice won the election.",
  }),
  Object.freeze({
    premise: "Alice or Bob won the election.",
    hypothesis: "Alice won the election.",
  }),
  Object.freeze({
    premise: "It is false that the system is safe.",
    hypothesis: "The system is safe.",
  }),
  Object.freeze({
    premise: "Neither Alice nor Bob won the election.",
    hypothesis: "Bob won the election.",
  }),
  Object.freeze({
    premise: "Alice or Bob won the election.",
    hypothesis: "Bob won the election.",
  }),
  Object.freeze({
    premise: "According to Bob, Alice won the election.",
    hypothesis: "Alice won the election.",
  }),
  Object.freeze({
    premise: "Maybe, Bob won the election.",
    hypothesis: "Bob won the election.",
  }),
  Object.freeze({
    premise: "The release passed all checks; or the release failed all checks.",
    hypothesis: "The release passed all checks.",
  }),
  Object.freeze({
    premise: "The measured value is not 42 units.",
    hypothesis: "The measured value is 99 units.",
  }),
  Object.freeze({
    premise: "According to a report,\nBob won the election.",
    hypothesis: "Bob won the election.",
  }),
  Object.freeze({
    premise: "The measured value is not 42 units.",
    hypothesis: "The measured value is not 99 units.",
  }),
  Object.freeze({
    premise: "The release passed all checks; the release failed all checks.",
    hypothesis: "The release passed all checks.",
  }),
]);
const modelBytes = JSON.stringify({
  asset: FrozenSymbolicNliModel,
  behavior: FrozenNliBehaviorProbes.map((probe) => ({
    ...probe,
    relation: frozenSymbolicNliInfer(probe.premise, probe.hypothesis),
  })),
});
export const FrozenNliModelFingerprint = `sha256:${createHash("sha256").update(modelBytes).digest("hex")}`;

export function frozenSymbolicNliInfer(premise: string, hypothesis: string): FrozenNliRelation {
  if (exceedsLineSegmentLimit(premise) || exceedsLineSegmentLimit(hypothesis)) return "unknown";
  const sourceSegments = segments(premise);
  const claimSegments = segments(hypothesis);
  if (sourceSegments.length > FrozenSymbolicNliModel.maxSegments || claimSegments.length !== 1) {
    return "unknown";
  }
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
  numbers: ReadonlySet<string>;
}>;

type ClaimFeatures = TextFeatures & Readonly<{ anchors: ReadonlySet<string> }>;

function inferSegment(premise: string, claim: ClaimFeatures): FrozenNliRelation {
  const source = textFeatures(premise);
  if (claim.sequence.length > source.sequence.length) return "unknown";
  if (claim.anchors.size > source.tokens.size) return "unknown";
  if (claimCoverage(source.tokens, claim.anchors) < 1) return "unknown";
  if (hasUnsupportedSourceContext(source, claim)) return "unknown";
  if (hasInternalOpposition(source.tokens)) return "unknown";
  const sourcePolarity = negationParity(source.sequence, claim.tokens);
  const claimPolarity = negationParity(claim.sequence, source.tokens);
  if (containsOpposition(source.tokens, claim.tokens)) {
    return sourcePolarity === claimPolarity ? "contradicts" : "unknown";
  }
  const lexicalCoverage = claimCoverage(source.words, claim.words);
  if (lexicalCoverage < FrozenSymbolicNliModel.claimCoverageThreshold) return "unknown";
  if (![...claim.numbers].every((number) => source.numbers.has(number))) {
    return source.numbers.size === 0 || sourcePolarity === 1 || claimPolarity === 1
      ? "unknown"
      : "contradicts";
  }
  if (sourcePolarity !== claimPolarity) return "contradicts";
  return isOrderedSubsequence(source.sequence, claim.sequence) ? "entails" : "unknown";
}

function segments(value: string): readonly string[] {
  const split = value
    .split(/(?:[!?]\s+|\.\s+)/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return split.length === 0 ? [value] : split;
}

function exceedsLineSegmentLimit(value: string): boolean {
  let lineSegments = 1;
  for (const character of value) {
    if (character === "\n") lineSegments += 1;
    if (lineSegments > FrozenSymbolicNliModel.maxSegments) return true;
  }
  return false;
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
    numbers: new Set(numbers(value)),
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

function negationParity(source: readonly string[], comparedClaim: ReadonlySet<string>): 0 | 1 {
  let negators = 0;
  let relevant = false;
  for (const token of source) {
    if (FrozenSymbolicNliModel.negators.includes(token)) negators += 1;
    else if (comparedClaim.has(token)) relevant = true;
  }
  return relevant && negators % 2 === 1 ? 1 : 0;
}

function numbers(value: string): string[] {
  return value.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

function claimCoverage(source: ReadonlySet<string>, claim: ReadonlySet<string>): number {
  if (claim.size === 0) return 0;
  let intersection = 0;
  for (const token of claim) if (source.has(token)) intersection += 1;
  return intersection / claim.size;
}

function hasUnsupportedSourceContext(source: TextFeatures, claim: TextFeatures): boolean {
  for (const word of source.words) {
    if (
      claim.words.has(word) ||
      FrozenSymbolicNliModel.allowedSourceModifiers.includes(word) ||
      FrozenSymbolicNliModel.negators.includes(word) ||
      isContradictionToken(word)
    ) {
      continue;
    }
    return true;
  }
  return false;
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

function hasInternalOpposition(source: ReadonlySet<string>): boolean {
  return FrozenSymbolicNliModel.contradictionGroups.some(
    ([left, right]) =>
      left.some((word) => source.has(word)) && right.some((word) => source.has(word)),
  );
}

function isContradictionToken(token: string): boolean {
  return FrozenSymbolicNliModel.contradictionGroups.some(([left, right]) =>
    [...left, ...right].includes(token),
  );
}
