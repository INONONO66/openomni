import { createHash } from "node:crypto";

const contradictionPairs = Object.freeze([
  Object.freeze(["increase", "decrease"]),
  Object.freeze(["present", "absent"]),
  Object.freeze(["accept", "reject"]),
  Object.freeze(["allow", "deny"]),
]);

export const FrozenSymbolicNliModel = Object.freeze({
  version: "openomni-frozen-symbolic-nli-v1",
  lexicalThreshold: 0.6,
  negators: Object.freeze(["no", "not", "never", "without"]),
  contradictionPairs,
});

const modelBytes = JSON.stringify(FrozenSymbolicNliModel);
export const FrozenNliModelFingerprint = `sha256:${createHash("sha256").update(modelBytes).digest("hex")}`;

export function frozenSymbolicNliSupports(premise: string, hypothesis: string): boolean {
  const sourceTokens = tokens(premise);
  const claimTokens = tokens(hypothesis);
  if (claimTokens.size === 0) return false;
  let intersection = 0;
  for (const token of claimTokens) if (sourceTokens.has(token)) intersection += 1;
  const union = new Set([...sourceTokens, ...claimTokens]).size;
  if (intersection / union < FrozenSymbolicNliModel.lexicalThreshold) return false;
  if (!numbers(hypothesis).every((number) => numbers(premise).includes(number))) return false;
  const sourceNegated = FrozenSymbolicNliModel.negators.some((word) => sourceTokens.has(word));
  const claimNegated = FrozenSymbolicNliModel.negators.some((word) => claimTokens.has(word));
  if (sourceNegated !== claimNegated) return false;
  for (const pair of FrozenSymbolicNliModel.contradictionPairs) {
    const left = pair[0];
    const right = pair[1];
    if (left === undefined || right === undefined) return false;
    if (
      (sourceTokens.has(left) && claimTokens.has(right)) ||
      (sourceTokens.has(right) && claimTokens.has(left))
    )
      return false;
  }
  return true;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function numbers(value: string): string[] {
  return value.match(/-?\d+(?:\.\d+)?/g) ?? [];
}
