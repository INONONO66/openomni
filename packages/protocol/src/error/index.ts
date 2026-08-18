import { z } from "zod";

export abstract class NamedError extends Error {
  abstract schema(): z.ZodType;
  abstract toObject(): { name: string; data: unknown };

  static create<Name extends string, Data extends z.ZodType>(name: Name, data: Data) {
    const schema = z.object({
      name: z.literal(name),
      data,
    });
    const result = class extends NamedError {
      public static readonly Schema = schema;

      public override readonly name = name as Name;

      constructor(
        public readonly data: z.input<Data>,
        options?: { cause?: unknown },
      ) {
        const message =
          typeof data === "object" &&
          data !== null &&
          "message" in data &&
          typeof data.message === "string"
            ? data.message
            : name;
        super(message);
        if (options?.cause) {
          Object.defineProperty(this, "cause", {
            value: options.cause,
            configurable: true,
            writable: true,
          });
        }
        this.name = name;
      }

      static isInstance(input: unknown): input is InstanceType<typeof result> {
        return (
          typeof input === "object" && input !== null && "name" in input && input.name === name
        );
      }

      schema() {
        return schema;
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        };
      }
    };
    Object.defineProperty(result, "name", { value: name });
    return result;
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
    }),
  );
}

// #500 C3: NamedError STAYS here — it is consumed by protocol's own schemas
// (ledger/schema.ts AdoptError, wait/schema.ts StoreError, communication
// pending-ask/pending-interaction FrozenError). The concrete errors that
// lived beside it moved to their caller-proven owners: APIError →
// @openomni/llm (src/error.ts — llm-only callers), WorkerDeliveryError →
// @openomni/coordinator (src/error.ts — coordinator + apps/server callers).
