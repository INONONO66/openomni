import { Storage } from "@openomni/ledger";

type DecisionFactPort = NonNullable<ReturnType<typeof Storage.get>["decisionFacts"]>;

/** Preserve the real transaction while replacing only the decision-fact seam. */
export function replaceDecisionFacts(
  replace: (facts: DecisionFactPort) => DecisionFactPort | undefined,
): void {
  const adapter = Storage.get();
  const facts = adapter.decisionFacts;
  if (facts === undefined) throw new Error("fixture requires decision facts");
  Storage.configure({
    ...adapter,
    transaction: adapter.transaction.bind(adapter),
    decisionFacts: replace(facts),
  });
}
