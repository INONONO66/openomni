import {
  canonicalDigest,
  NamedError,
  type PlainValue,
  PlainValueSchema,
  PolicyRef,
} from "@openomni/protocol";
import { z } from "zod";
import { clonePlain, freezePlain } from "./match";
import type { GateHandler } from "./compose";

/**
 * Named policy services (#1251): the registry of transformer/obligation
 * handlers a composition ships, the kernel's built-in registry, and the
 * wrapper that exposes a named transformer as a gate handler with a
 * digest-recorded response.
 */

export interface NamedTransformer {
  readonly name: string;
  readonly apply: (args: PlainValue, config: PlainValue) => PlainValue;
}

interface NamedObligation {
  readonly name: string;
}

export interface HandlerTable {
  readonly transformers: readonly NamedTransformer[];
  readonly obligations: readonly NamedObligation[];
}

export const HandlerTableError = NamedError.create(
  "HandlerTableError",
  z
    .object({
      code: z.enum(["invalid_ref", "duplicate_ref"]),
      ref: z.string(),
    })
    .strict(),
);

/** Copies definitions, never freezes caller objects or exposes mutable Maps. */
export function createHandlerTable(input: HandlerTable): HandlerTable {
  const names = new Set<string>();
  for (const entry of [...input.transformers, ...input.obligations]) {
    if (!PolicyRef.safeParse(entry.name).success)
      throw new HandlerTableError({ code: "invalid_ref", ref: entry.name });
    if (names.has(entry.name))
      throw new HandlerTableError({ code: "duplicate_ref", ref: entry.name });
    names.add(entry.name);
  }
  return Object.freeze({
    transformers: Object.freeze(
      input.transformers.map(({ name, apply }) => Object.freeze({ name, apply })),
    ),
    obligations: Object.freeze(input.obligations.map(({ name }) => Object.freeze({ name }))),
  });
}

const RedactConfig = z
  .object({
    paths: z.array(z.string().min(1)).default([]),
    replacement: PlainValueSchema.optional(),
  })
  .strict();

function redact(args: PlainValue, config: PlainValue): PlainValue {
  const { paths, replacement } = RedactConfig.parse(config ?? {});
  const output = clonePlain(args);
  for (const path of paths) {
    const fields = path.split(".");
    const leaf = fields.pop();
    if (leaf === undefined || leaf.length === 0) continue;
    let parent: PlainValue | undefined = output;
    for (const field of fields) {
      parent =
        parent !== null &&
        typeof parent === "object" &&
        !Array.isArray(parent) &&
        Object.getOwnPropertyDescriptor(parent, field) !== undefined
          ? parent[field]
          : undefined;
    }
    if (
      parent === undefined ||
      parent === null ||
      Array.isArray(parent) ||
      typeof parent !== "object"
    )
      continue;
    if (replacement === undefined) delete parent[leaf];
    else
      Object.defineProperty(parent, leaf, {
        value: clonePlain(replacement),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return output;
}

export const KERNEL_POLICY_REGISTRY: HandlerTable = createHandlerTable({
  transformers: [{ name: "kernel/redact", apply: redact }],
  obligations: [{ name: "kernel/budget-clamp" }],
});


export function wrapTransformer(transformer: NamedTransformer): GateHandler {
  return (input) => {
    const output = transformer.apply(freezePlain(input.value), input.params ?? null);
    return {
      value: output,
      payload: { ref: transformer.name, output: canonicalDigest(output) },
    };
  };
}
