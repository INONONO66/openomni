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
    tokens,
    numbers,
    wordTokens,
    claimCoverage,
    containsOpposition,
  ].map((value) => value.toString()),
});
export const FrozenNliModelFingerprint = `sha256:${createHash("sha256").update(modelBytes).digest("hex")}`;

export function frozenSymbolicNliInfer(premise: string, hypothesis: string): FrozenNliRelation {
  const sourceTokens = tokens(premise);
  const claimTokens = tokens(hypothesis);
  if (claimTokens.size === 0) return "unknown";
  if (containsOpposition(sourceTokens, claimTokens)) return "contradicts";
  const lexicalCoverage = claimCoverage(wordTokens(premise), wordTokens(hypothesis));
  if (lexicalCoverage < FrozenSymbolicNliModel.claimCoverageThreshold) return "unknown";
  if (!numbers(hypothesis).every((number) => numbers(premise).includes(number))) {
    return "contradicts";
  }
  const sourceNegated = FrozenSymbolicNliModel.negators.some((word) => sourceTokens.has(word));
  const claimNegated = FrozenSymbolicNliModel.negators.some((word) => claimTokens.has(word));
  return sourceNegated === claimNegated ? "entails" : "contradicts";
}

function pair(
  left: readonly string[],
  right: readonly string[],
): readonly [readonly string[], readonly string[]] {
  return Object.freeze([Object.freeze(left), Object.freeze(right)]);
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
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
