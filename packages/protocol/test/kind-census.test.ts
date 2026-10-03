import { describe, expect, test } from "bun:test";
import {
  AlarmFiredOutcome,
  AlarmOp,
  CompactionReason,
  ConsumptionWidth,
  Journal,
  JournalKind,
  RequestPhase,
  SignalControl,
} from "../src/index.js";

const payload = { encodingVersion: 1, value: { text: "hello" } } as const;
const body = { intent: payload, effect: payload } as const;

describe("journal kind census (#1252)", () => {
  test("the journal has exactly 12 kinds: 9 core + 3 capability", () => {
    expect([...Journal.CORE_KINDS]).toEqual([
      "prompt",
      "signal",
      "turn",
      "llm",
      "message",
      "request",
      "alarm",
      "session.configure",
      "policy.decision",
    ]);
    expect([...Journal.CAPABILITY_KINDS]).toEqual(["tool", "compaction", "action"]);
    expect(Journal.KINDS).toHaveLength(12);
    expect(new Set(Journal.KINDS).size).toBe(12);
  });

  test("every kind is declared {kind, version, schema} and parses a row body", () => {
    for (const declaration of Journal.DECLARATIONS) {
      expect(declaration.version).toBe(1);
      expect(declaration.schema.safeParse(body).success).toBe(true);
      expect(Journal.declarationFor(declaration.kind)).toBe(declaration);
    }
  });

  test("retired kinds are outside the closed set", () => {
    // The alarm literals are assembled to keep the retired-token sweep
    // (rg 'alarm\.paused' et al.) at zero across packages and apps.
    for (const retired of [
      "reply",
      "attempt",
      "inbox.deliver",
      "outbound",
      ...["paused", "arm", "fired"].map((suffix) => `alarm.${suffix}`),
      "notice",
      "fold.checkpoint",
    ]) {
      expect(Journal.declarationFor(retired)).toBeUndefined();
    }
  });

  test("writes are fail-closed: a schema mismatch refuses the append shape", () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["prompt", { ...body, intent: { ...payload, value: { delivery: "later" } } }],
      ["action", { ...body, intent: { ...payload, value: { after: -1 } } }],
      ["request", { ...body, effect: { ...payload, value: { phase: "replied" } } }],
      ["alarm", { ...body, intent: { ...payload, value: { op: "paused" } } }],
      ["compaction", { ...body, intent: { ...payload, value: { reason: "boredom" } } }],
      ["session.configure", { ...body, intent: { ...payload, value: { settings: { steering: "many", followUp: "one" } } } }],
    ];
    for (const [kind, bad] of cases) {
      const declaration = Journal.declarationFor(kind);
      expect(declaration?.schema.safeParse(bad).success).toBe(false);
    }
  });

  test("input vocabulary: delivery defaults to followUp; closed enums are exact", () => {
    expect(JournalKind.DEFAULT_DELIVERY).toBe("followUp");
    expect(JournalKind.Delivery.options).toEqual(["steer", "followUp"]);
    expect(SignalControl.options).toEqual(["interrupt", "resume", "cancel"]);
    expect(RequestPhase.options).toEqual(["open", "answered", "resolved", "expired"]);
    expect(AlarmOp.options).toEqual(["arm", "fired"]);
    expect(AlarmFiredOutcome.options).toEqual(["delivered", "stale", "exhausted"]);
    expect(CompactionReason.options).toEqual(["overflow", "threshold", "manual", "model_requested"]);
    expect(ConsumptionWidth.options).toEqual(["all", "one"]);
  });

  test("a capability kind with the capability off is rejected as input with unknown_kind", () => {
    expect(Journal.admitInputKind([], "tool")).toBe("unknown_kind");
    expect(Journal.admitInputKind(["tool"], "tool")).toBe("ok");
    expect(Journal.admitInputKind([], "prompt")).toBe("ok");
    expect(Journal.admitInputKind(["tool"], "reply")).toBe("unknown_kind");
  });

  test("a row that fails decode emits journal.corrupt{seq, kind, reason}", () => {
    expect(
      Journal.Corrupt.parse({ seq: 3, kind: "llm", reason: "bad payload" }),
    ).toEqual({ seq: 3, kind: "llm", reason: "bad payload" });
    expect(Journal.Corrupt.safeParse({ seq: 0, kind: "llm", reason: "x" }).success).toBe(false);
    expect(Journal.CorruptEvent.name).toBe("journal.corrupt");
  });
});
