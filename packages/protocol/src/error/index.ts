import { z } from "zod";

// Cross-copy identity brand: bun resolves each workspace package's
// node_modules symlink to @openomni/protocol independently, so one process
// can hold two copies of a generated error class. `instanceof` alone is
// therefore unsound across package boundaries; the Symbol.for-registered
// brand carries the error name and is set only by this factory, so the
// guard recognizes instances from any copy while still rejecting plain
// objects that merely mimic the `name` property. The brand alone cannot
// distinguish same-named factories with different schemas, so isInstance
// additionally validates the candidate's `data` against this factory's
// schema — the guard's type predicate is only sound when the payload
// actually has the promised shape.
const NAMED_ERROR_BRAND = Symbol.for("openomni.protocol.namedError");

export abstract class NamedError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = "NamedError";
  }

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
        if (options !== undefined && "cause" in options) {
          Object.defineProperty(this, "cause", {
            value: options.cause,
            configurable: true,
            writable: true,
          });
        }
        this.name = name;
      }

      static isInstance(input: unknown): input is InstanceType<typeof result> {
        if (!(input instanceof Error)) return false;
        if ((input as unknown as Partial<Record<symbol, unknown>>)[NAMED_ERROR_BRAND] !== name) {
          return false;
        }
        return data.safeParse((input as { data?: unknown }).data).success;
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
    Object.defineProperty(result.prototype, NAMED_ERROR_BRAND, { value: name });
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
// (ledger/schema.ts AdoptError, wait/schema.ts StoreError). The concrete errors that
// lived beside it moved to their caller-proven owners: APIError →
// @openomni/llm (src/error.ts — llm-only callers). The removed local-process
// worker stack owned its own delivery error rather than exporting it here.
