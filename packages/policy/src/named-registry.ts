import { NamedError, PolicyRef, type PlainValue, PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";
import { clonePlain } from "./plain";

export interface NamedTransformer {
  readonly name: string;
  readonly apply: (args: PlainValue, config: PlainValue) => PlainValue;
}

interface NamedObligation {
  readonly name: string;
}

export interface NamedPolicyRegistry {
  readonly transformers: readonly NamedTransformer[];
  readonly obligations: readonly NamedObligation[];
}

export const NamedPolicyRegistryError = NamedError.create(
  "NamedPolicyRegistryError",
  z
    .object({
      code: z.enum(["invalid_ref", "duplicate_ref"]),
      ref: z.string(),
    })
    .strict(),
);

/** Copies definitions, never freezes caller objects or exposes mutable Maps. */
export function createNamedPolicyRegistry(input: NamedPolicyRegistry): NamedPolicyRegistry {
  const names = new Set<string>();
  for (const entry of [...input.transformers, ...input.obligations]) {
    if (!PolicyRef.safeParse(entry.name).success)
      throw new NamedPolicyRegistryError({ code: "invalid_ref", ref: entry.name });
    if (names.has(entry.name))
      throw new NamedPolicyRegistryError({ code: "duplicate_ref", ref: entry.name });
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

export const KERNEL_POLICY_REGISTRY: NamedPolicyRegistry = createNamedPolicyRegistry({
  transformers: [{ name: "kernel/redact", apply: redact }],
  obligations: [{ name: "kernel/budget-clamp" }],
});
