import { expect } from "bun:test";
import { commits, ownerFacts, routingDecisions } from "./_router-fixture";

export function expectEvidenceOnlyCommit(): void {
  expect(routingDecisions()[0]).toMatchObject({
    outcome: "route",
    inboundTreatment: "evidence_only",
  });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.content).toBe(ownerFacts.render);
  expect(commits[0]?.origin.value).toMatchObject({ inboundTreatment: "evidence_only" });
}
