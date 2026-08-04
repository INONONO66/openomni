import type { WorkItem } from "@openomni/protocol";
import { completionAdmissionScenarioReceipt } from "./completion-admission-driver-contract.js";
import { type CompletionSourceOrigin, projectCompletionOrigin } from "./completion-origin.js";

type OriginExpectation = Readonly<{
  source: CompletionSourceOrigin;
  origin: WorkItem.CompletionOrigin;
}>;

const OriginExpectations = [
  { source: { source: "resident" }, origin: "resident" },
  { source: { source: "internal_worker" }, origin: "worker" },
  { source: { source: "connector_worker" }, origin: "worker" },
  { source: { source: "api" }, origin: "external_actor" },
  { source: { source: "a2a" }, origin: "external_actor" },
  { source: { source: "human" }, origin: "external_actor" },
  {
    source: { source: "sdk", identity: { kind: "resident", id: "resident:driver" } },
    origin: "resident",
  },
  {
    source: { source: "sdk", identity: { kind: "worker", id: "worker:sdk-driver" } },
    origin: "worker",
  },
  {
    source: { source: "sdk", identity: { kind: "external_actor", id: "actor:sdk-driver" } },
    origin: "external_actor",
  },
  {
    source: { source: "internal", identity: { kind: "resident", id: "resident:internal-driver" } },
    origin: "resident",
  },
  {
    source: { source: "internal", identity: { kind: "worker", id: "worker:internal-driver" } },
    origin: "worker",
  },
  {
    source: {
      source: "internal",
      identity: { kind: "external_actor", id: "actor:internal-driver" },
    },
    origin: "external_actor",
  },
  { source: { source: "replay" }, origin: "replay" },
  { source: { source: "recovery" }, origin: "recovery" },
] as const satisfies readonly OriginExpectation[];

const CanonicalOrigins = ["resident", "worker", "external_actor", "replay", "recovery"] as const;

export function runAllOriginsCompletionAdmissionScenario(
  project: typeof projectCompletionOrigin = projectCompletionOrigin,
) {
  const sourceReceipts = OriginExpectations.map(({ source }) => ({
    source: sourceLabel(source),
    origin: project(source),
  }));
  const sourceMappingsExact = sourceReceipts.every(
    ({ origin }, index) => origin === OriginExpectations[index]?.origin,
  );

  return completionAdmissionScenarioReceipt(
    "all-origins",
    sourceMappingsExact,
    "all_origins_projected",
    "origin_projection_incomplete",
    { canonicalOrigins: CanonicalOrigins, sourceMappingsExact, sourceReceipts },
  );
}

function sourceLabel(source: CompletionSourceOrigin): string {
  if (source.source === "sdk" || source.source === "internal") {
    return `${source.source}:${source.identity.kind}`;
  }
  return source.source;
}
