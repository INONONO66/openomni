import z from "zod";
import { APIError, AuthInvalidFileError, AuthResolutionError, ForeignFailure, InvalidProviderData, LlmRunFailure, ModelResolutionError, ProxyModelsError, TransportFailure, type LlmError } from "./errors";

export { APIError } from "./errors";
const ErrorFacts = z.object({
  aborted: z.boolean().optional().catch(undefined),
  contextOverflow: z.boolean().optional().catch(undefined),
});
export type ErrorFacts = z.infer<typeof ErrorFacts>;
export function errorFacts<E>(error: E): ErrorFacts {
  return ErrorFacts.catch({}).parse(error);
}
export function declaredContextOverflow<E>(error: E): boolean | undefined {
  return error instanceof APIError || error instanceof LlmRunFailure ? error.contextOverflow : undefined;
}
const ResponseHeaders = z.record(z.string(), z.string().optional().catch(undefined)).catch({}).transform((headers) => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) result[key.toLowerCase()] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
});
const ProviderFailure = ErrorFacts.extend({
  message: z.string(), isRetryable: z.boolean(),
  name: z.string().optional().catch(undefined),
  providerErrorName: z.string().optional().catch(undefined),
  statusCode: z.number().optional().catch(undefined),
  responseHeaders: ResponseHeaders,
  responseBody: z.string().optional().catch(undefined),
}).transform(({ name, providerErrorName, ...facts }) => ({ ...facts, providerErrorName: providerErrorName ?? name }));
export type ApiFailure = APIError;
/** Preserve provider retry metadata as values, never as a native Error cause chain. */
export function coerceApiError<E>(error: E): ApiFailure | undefined {
  if (error instanceof APIError) return error;
  const candidate = ProviderFailure.safeParse(error);
  return candidate.success ? new APIError({ ...candidate.data, cause: String(error) }) : undefined;
}

const KnownFailure = z.union([
  z.instanceof(APIError), z.instanceof(AuthInvalidFileError), z.instanceof(AuthResolutionError),
  z.instanceof(ForeignFailure), z.instanceof(InvalidProviderData), z.instanceof(LlmRunFailure),
  z.instanceof(ModelResolutionError), z.instanceof(ProxyModelsError), z.instanceof(TransportFailure),
]);
export function decodeLlmFailure(operation: string) {
  return z.union([
    KnownFailure,
    ProviderFailure.transform((fields) => new APIError(fields)),
    z.instanceof(Error).transform((error) => new TransportFailure({ operation, message: error.message, providerErrorName: error.name, aborted: error.name === "AbortError", cause: String(error) })),
    z.preprocess(String, z.string()).transform((cause) => new ForeignFailure({ operation, cause })),
  ]).transform((failure): LlmError => failure).parse;
}
