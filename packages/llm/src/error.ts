import z from "zod"

export abstract class NamedError extends Error {
  abstract schema(): z.ZodType
  abstract toObject(): { name: string; data: any }

  static create<Name extends string, Data extends z.ZodType>(name: Name, data: Data) {
    const schema = z.object({
      name: z.literal(name),
      data,
    })
    const result = class extends NamedError {
      public static readonly Schema = schema

      public override readonly name = name as Name

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        const message = typeof data === "object" && data !== null && "message" in data && typeof data.message === "string" ? data.message : name
        super(message, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return typeof input === "object" && input !== null && "name" in input && input.name === name
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
    }),
  )
}

export const AuthError = NamedError.create(
  "AuthError",
  z.object({
    message: z.string(),
    provider: z.string(),
  }),
)

export const ProviderError = NamedError.create(
  "ProviderError",
  z.object({
    message: z.string(),
    provider: z.string(),
  }),
)

export const TokenRefreshError = NamedError.create(
  "TokenRefreshError",
  z.object({
    message: z.string(),
    status: z.number(),
  }),
)
