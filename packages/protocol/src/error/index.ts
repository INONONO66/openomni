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

/**
 * Typed rejection taxonomy for the worker driver's `deliver` verb (#462 §4).
 * Callers branch on `data.code`, never on message text.
 */
export const WorkerDeliveryError = NamedError.create(
  "WorkerDeliveryError",
  z.object({
    message: z.string(),
    code: z.enum([
      "queue_full",
      "shutting_down",
      "duplicate_run",
      "slot_wait_timeout",
      "worker_restarted",
      "session_mismatch",
    ]),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
);

export const APIError = NamedError.create(
  "APIError",
  z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
);
