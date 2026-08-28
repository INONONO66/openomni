import { describe, expect, test } from "bun:test";
import { ZodError, type z } from "zod";
import { Ingress } from "../../src/ingress/index.js";

const RoutingDecision = Ingress.Events.RoutingDecision;
const routingDecisionSchema = RoutingDecision.schema;

type RoutingDecisionInput = z.input<typeof routingDecisionSchema>;

const baseDecision = {
  traceId: "trace-1",
  time: 1_750_000_000_000,
  inboundId: "inbound-1",
  surface: "discord:channel:42",
  mode: "direct" as const,
  reason: "terminal routing decision",
  factsUsed: ["inbound.normalized", "surface.discord"],
  target: "resident",
};

const terminalCases: RoutingDecisionInput[] = [
  { ...baseDecision, stage: "blacklist", outcome: "drop" },
  {
    ...baseDecision,
    stage: "wait_correlation",
    outcome: "route",
    target: "resident",
    sessionId: "session-1",
    actorId: "actor-1",
    trustTier: "assigned_worker",
    inboundTreatment: "full_access",
  },
  // Exercises both the source-prefix regex and minimum candidate count
  // refinements of the ambiguous arm.
  {
    ...baseDecision,
    stage: "wait_correlation",
    outcome: "ambiguous",
    candidateInteractionIds: ["wait:wait-2", "wait:wait-3"],
  },
  // Fail-closed wait stage (#215): a matched wait whose owner has no ingress
  // delivery path blocks instead of falling through to surface routing.
  { ...baseDecision, stage: "wait_correlation", outcome: "block" },
  { ...baseDecision, stage: "channel_ceiling", outcome: "block", inboundTreatment: "drop" },
  {
    ...baseDecision,
    stage: "actor_identity",
    outcome: "block",
    actorId: "actor-2",
    trustTier: "observer",
  },
  {
    ...baseDecision,
    stage: "surface_default",
    outcome: "route",
    mode: "internal",
    target: "resident",
    sessionId: "session-2",
    actorId: "system:cron",
    factsUsed: ["actor.system:cron", "surface.default.session-2"],
  },
];

const invalidTerminalPairs = [
  ["blacklist", "route"],
  ["blacklist", "block"],
  ["blacklist", "ambiguous"],
  ["wait_correlation", "drop"],
  ["channel_ceiling", "route"],
  ["channel_ceiling", "drop"],
  ["channel_ceiling", "ambiguous"],
  ["actor_identity", "route"],
  ["actor_identity", "drop"],
  ["actor_identity", "ambiguous"],
  ["surface_default", "drop"],
  ["surface_default", "block"],
  ["surface_default", "ambiguous"],
];

describe("Ingress.Events.RoutingDecision", () => {
  test("uses the durable routing decision descriptor", () => {
    // Given / When: the exported routing decision descriptor
    // Then
    expect(RoutingDecision.name).toBe("ingress.routing.decision");
    expect(RoutingDecision.visibility).toBe("user_audit");
  });

  for (const terminal of terminalCases) {
    test(`parses the terminal ${terminal.stage}/${terminal.outcome} decision`, () => {
      // Given
      const input = terminal;

      // When
      const parsed = routingDecisionSchema.parse(input);

      // Then
      expect(parsed).toEqual(input);
    });
  }

  test("preserves the evidence order in factsUsed", () => {
    // Given
    const input = {
      ...baseDecision,
      stage: "surface_default",
      outcome: "route",
      factsUsed: ["blacklist.clear", "channel.full_access", "surface.session-2"],
    };

    // When
    const parsed = routingDecisionSchema.parse(input);

    // Then
    expect(parsed.factsUsed).toEqual(input.factsUsed);
  });

  for (const requiredField of [
    "traceId",
    "time",
    "inboundId",
    "surface",
    "mode",
    "stage",
    "outcome",
    "reason",
    "factsUsed",
    "target",
  ]) {
    test(`requires ${requiredField}`, () => {
      // Given
      const input = {
        ...baseDecision,
        stage: "surface_default",
        outcome: "route",
      };
      Reflect.deleteProperty(input, requiredField);

      // When / Then
      expect(() => routingDecisionSchema.parse(input)).toThrow(ZodError);
    });
  }

  for (const [stage, outcome] of invalidTerminalPairs) {
    test(`rejects the invalid terminal ${stage}/${outcome} pair`, () => {
      // Given
      const input = { ...baseDecision, stage, outcome };

      // When / Then
      expect(() => routingDecisionSchema.parse(input)).toThrow(ZodError);
    });
  }

  test("rejects candidate interaction IDs outside an ambiguous decision", () => {
    // Given
    const input = {
      ...baseDecision,
      stage: "wait_correlation",
      outcome: "route",
      candidateInteractionIds: ["pi-1", "pi-2"],
    };

    // When / Then
    expect(() => routingDecisionSchema.parse(input)).toThrow(ZodError);
  });

  test("requires at least two source-qualified candidates for an ambiguous decision", () => {
    // Given
    const ambiguous = {
      ...baseDecision,
      stage: "wait_correlation",
      outcome: "ambiguous",
    };

    // When / Then
    expect(() =>
      routingDecisionSchema.parse({
        ...ambiguous,
        candidateInteractionIds: ["wait:wait-1"],
      }),
    ).toThrow(ZodError);
    expect(() =>
      routingDecisionSchema.parse({
        ...ambiguous,
        candidateInteractionIds: ["wait-1", "wait:wait-2"],
      }),
    ).toThrow(ZodError);
  });

  test("rejects the retired plan mode", () => {
    // Given
    const input = { ...baseDecision, mode: "plan", stage: "surface_default", outcome: "route" };

    // When / Then
    expect(() => routingDecisionSchema.parse(input)).toThrow(ZodError);
  });
});

describe("Ingress.recordedRoutingDecision (upcast-on-read)", () => {
  test("strips the dead runId/pendingInteractionId fields from pre-0025 facts", () => {
    // Given — a persisted wait route recorded before the pending-stack
    // deletion, carrying both dead optional fields the strict schema rejects.
    const legacyFact = {
      ...baseDecision,
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: "session-1",
      actorId: "actor-1",
      runId: "run-legacy-1",
      pendingInteractionId: "ask_legacy-1",
    };
    expect(() => routingDecisionSchema.parse(legacyFact)).toThrow(ZodError);

    // When
    const upcast = Ingress.recordedRoutingDecision(legacyFact);

    // Then — the modern payload survives, minus the dead fields.
    expect(upcast).toEqual({
      ...baseDecision,
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: "session-1",
      actorId: "actor-1",
    });
  });

  test("reads legacy pending-prefixed ambiguous candidates verbatim", () => {
    // Given — a pre-0025 ambiguous decision whose candidates mix wait and
    // pending sources; the write schema's wait-only regex rejects it.
    const legacyAmbiguous = {
      ...baseDecision,
      stage: "wait_correlation" as const,
      outcome: "ambiguous" as const,
      candidateInteractionIds: ["wait:wait-1", "pending_ask:ask-1", "pending_interaction:pi-1"],
    };
    expect(() => routingDecisionSchema.parse(legacyAmbiguous)).toThrow(ZodError);

    // When
    const upcast = Ingress.recordedRoutingDecision(legacyAmbiguous);

    // Then — candidates are preserved as written (comparison-only vocabulary).
    expect(upcast).toEqual(legacyAmbiguous);
  });

  test("parses modern facts unchanged", () => {
    for (const terminal of terminalCases) {
      expect(Ingress.recordedRoutingDecision(terminal)).toEqual(
        routingDecisionSchema.parse(terminal),
      );
    }
  });

  test("returns undefined for bytes no era could parse", () => {
    expect(Ingress.recordedRoutingDecision(undefined)).toBeUndefined();
    expect(Ingress.recordedRoutingDecision(null)).toBeUndefined();
    expect(Ingress.recordedRoutingDecision("route")).toBeUndefined();
    expect(Ingress.recordedRoutingDecision({ stage: "blacklist" })).toBeUndefined();
    expect(
      Ingress.recordedRoutingDecision({
        ...baseDecision,
        stage: "wait_correlation",
        outcome: "ambiguous",
        candidateInteractionIds: ["unqualified-1", "unqualified-2"],
      }),
    ).toBeUndefined();
  });
});
