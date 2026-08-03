import { isProxy } from "node:util/types";
import { z } from "zod";
import {
  JsonValueSchema,
  freezeJson,
  snapshotFirstJsonSchema,
  snapshotFirstSchema,
  type JsonValue,
} from "./verifier-conformance-canonical.js";

const forbiddenUpcasterKeys = new Set(["__proto__", "constructor", "prototype"]);

const VersionedEventContract = z
  .object({
    eventType: z.string().min(1).max(256),
    meaning: z.string().min(1).max(1_024),
    schemaVersion: z.number().int().safe().positive(),
    payload: JsonValueSchema,
  })
  .strict();
export const VersionedEventSchema = snapshotFirstJsonSchema(
  JsonValueSchema.pipe(VersionedEventContract),
);
type VersionedEventShape = z.infer<typeof VersionedEventSchema>;
export type VersionedEvent = Readonly<Omit<VersionedEventShape, "payload">> & {
  readonly payload: JsonValue;
};

export const UpcasterSchema = snapshotFirstSchema(
  z
    .object({
      eventType: z.string().min(1).max(256),
      meaning: z.string().min(1).max(1_024),
      fromVersion: z.number().int().safe().positive(),
      toVersion: z.number().int().safe().positive(),
      upcast: z.function().args(VersionedEventContract).returns(z.unknown()),
    })
    .strict(),
  snapshotUpcaster,
);
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
  const target = z.number().int().safe().positive().parse(targetInput);
  const steps = z.array(UpcasterSchema).max(128).parse(snapshotUpcasterList(stepInputs));
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

function snapshotUpcasterList(input: unknown): readonly unknown[] {
  if (isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error("expected plain upcaster list");
  }
  if (input.length > 128) throw new Error("too many upcasters");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== input.length + 1 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)) ||
        (key !== "length" && Number(key) >= input.length),
    )
  ) {
    throw new Error("invalid upcaster list shape");
  }
  const output: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new Error("expected dense data-only upcaster list");
    }
    output.push(snapshotUpcaster(descriptor.value));
  }
  return Object.freeze(output);
}

function snapshotUpcaster(input: unknown): Readonly<Record<string, unknown>> {
  const prototype =
    input === null || typeof input !== "object" || isProxy(input)
      ? undefined
      : Object.getPrototypeOf(input);
  if (
    isProxy(input) ||
    input === null ||
    typeof input !== "object" ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error("expected plain upcaster");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || forbiddenUpcasterKeys.has(key))) {
    throw new Error("invalid upcaster key");
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new Error("expected data-only upcaster fields");
    }
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return Object.freeze(output);
}
