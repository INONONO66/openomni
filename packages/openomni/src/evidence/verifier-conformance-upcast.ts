import { z } from "zod";
import { JsonValueSchema, freezeJson, type JsonValue } from "./verifier-conformance-canonical.js";

export const VersionedEventSchema = z
  .object({
    eventType: z.string().min(1).max(256),
    meaning: z.string().min(1).max(1_024),
    schemaVersion: z.number().int().positive(),
    payload: JsonValueSchema,
  })
  .strict();
type VersionedEventShape = z.infer<typeof VersionedEventSchema>;
export type VersionedEvent = Readonly<Omit<VersionedEventShape, "payload">> & {
  readonly payload: JsonValue;
};

export const UpcasterSchema = z
  .object({
    eventType: z.string().min(1).max(256),
    meaning: z.string().min(1).max(1_024),
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
    upcast: z.function().args(VersionedEventSchema).returns(z.unknown()),
  })
  .strict();
type UpcasterShape = z.infer<typeof UpcasterSchema>;
export type Upcaster = Readonly<UpcasterShape>;

function freezeEvent(event: VersionedEvent): VersionedEvent {
  freezeJson(event.payload);
  return Object.freeze(event);
}

export function upcastOnRead(
  eventInput: VersionedEvent,
  targetInput: number,
  stepInputs: readonly Upcaster[],
): VersionedEvent {
  let current = freezeEvent(VersionedEventSchema.parse(eventInput));
  const target = z.number().int().positive().parse(targetInput);
  const steps = z.array(UpcasterSchema).max(128).parse(stepInputs);
  if (target < current.schemaVersion) throw new Error("upcast target precedes stored version");
  while (current.schemaVersion < target) {
    const candidates = steps.filter(
      (step) => step.eventType === current.eventType && step.fromVersion === current.schemaVersion,
    );
    if (candidates.length !== 1) throw new Error(`upcast gap at version ${current.schemaVersion}`);
    const step = candidates[0];
    if (step === undefined || step.toVersion !== current.schemaVersion + 1) {
      throw new Error(`upcast gap at version ${current.schemaVersion}`);
    }
    if (step.meaning !== current.meaning) {
      throw new Error(`upcast re-meaning at version ${current.schemaVersion}`);
    }
    const next = VersionedEventSchema.parse(step.upcast(current));
    if (next.eventType !== current.eventType || next.meaning !== current.meaning) {
      throw new Error(`upcast re-meaning at version ${current.schemaVersion}`);
    }
    if (next.schemaVersion !== step.toVersion) {
      throw new Error(`upcast returned wrong version from ${current.schemaVersion}`);
    }
    current = freezeEvent(next);
  }
  return current;
}
