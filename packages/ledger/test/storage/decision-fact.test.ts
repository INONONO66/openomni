import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DecisionFact } from "@openomni/protocol";
import { createDecisionFactPort } from "../../src/storage/decision-fact-port";
import { computeDecisionFactHash } from "../../src/storage/l0-hash";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();

const input = {
  key: "route:first",
  type: "route.decided",
  data: { value: "a|b" },
  timeCreated: 10,
};

test("first writer wins and every outcome carries the exact recorded fact", () => {
  const facts = stores.session.decisionFacts;
  expect(facts.head(input.key)).toBeUndefined();
  const first = facts.record(input);
  expect(first).toEqual({
    kind: "recorded",
    fact: {
      ...input,
      rowHash: computeDecisionFactHash({ ...input, data: JSON.stringify(input.data) }),
    },
  });
  expect(DecisionFact.Outcome.parse(first)).toEqual(first);
  expect(
    facts.record({ ...input, type: "other", data: { changed: true }, timeCreated: 20 }),
  ).toEqual({ kind: "exists", fact: first.fact });
  expect(facts.head(input.key)).toEqual(first.fact);
  const framed = JSON.stringify([
    input.key,
    input.type,
    JSON.stringify(input.data),
    input.timeCreated,
  ]);
  expect(first.fact.rowHash).toBe(createHash("sha256").update(framed).digest("hex"));
  for (const changed of [
    { key: "route:other" },
    { type: "other" },
    { data: "{}" },
    { timeCreated: 11 },
  ]) {
    expect(
      computeDecisionFactHash({ ...input, data: JSON.stringify(input.data), ...changed }),
    ).not.toBe(first.fact.rowHash);
  }
});

test("decision facts share the store transaction and roll back with it", () => {
  const port = createDecisionFactPort(stores.session);
  const failure = new Error("rollback");
  expect(() =>
    port.transaction(() => {
      expect(port.port()?.record(input).kind).toBe("recorded");
      throw failure;
    }),
  ).toThrow(failure);
  expect(stores.session.decisionFacts.head(input.key)).toBeUndefined();
  stores.session.transaction(() =>
    expect(stores.session.decisionFacts.record(input).kind).toBe("recorded"),
  );
  expect(stores.session.decisionFacts.head(input.key)?.data).toEqual(input.data);
});

test("decision facts keep fractional epoch instants without rounding", () => {
  const facts = stores.session.decisionFacts;
  const outcome = facts.record({ ...input, key: "route:fractional", timeCreated: 1.5 });
  expect(outcome.kind).toBe("recorded");
  if (outcome.kind !== "recorded") throw new Error("expected recorded outcome");
  expect(outcome.fact.timeCreated).toBe(1.5);
  expect(facts.head("route:fractional")?.timeCreated).toBe(1.5);
});
