import { APICallError } from "ai";
import { AgentFailure } from "../kernel/failure";

export { AgentFailure };
import { Data } from "effect";
import { z } from "zod";

const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
const MessageFields = z.object({ message: z.string(), cause: z.string().optional() });
const ProviderIdentity = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  usageProvenance: z.enum(["reported", "estimated", "unknown"]).optional(),
});

/**
 * Thin typed identity over the SDK's own `APICallError`: provider facts
 * (status, headers, body, retryability) live on the SDK error under `cause`
 * and are never copied; this adds only the call identity the SDK lacks.
 */
export class APIError extends Data.TaggedError("APIError")<
  z.infer<typeof ProviderIdentity> & { readonly cause: APICallError }
> {
  override get message(): string {
    return this.cause.message;
  }
}

const UsageFields = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});
const RunFields = ProviderIdentity.extend({
  message: z.string(),
  cause: z.union([z.instanceof(APICallError), z.string()]).optional(),
  retryAfterMs: z.number().nonnegative().optional(),
  usage: UsageFields,
  aborted: z.boolean(),
  contextOverflow: z.boolean(),
  visibleOutput: z.boolean(),
});
export class LlmRunFailure extends Data.TaggedError("LlmRunFailure")<z.infer<typeof RunFields>> {}

const ResolutionFields = MessageFields.extend({
  provider: z.string(),
  model: z.string(),
  reason: z.enum(["provider_not_found", "proxy_listing_failed", "model_not_found"]),
});
export class ModelResolutionError extends Data.TaggedError("ModelResolutionError")<
  z.infer<typeof ResolutionFields>
> {}
const FileFields = MessageFields.extend({ path: z.string() });
export class AuthInvalidFileError extends Data.TaggedError("AuthInvalidFileError")<
  z.infer<typeof FileFields>
> {}
const AuthFields = MessageFields.extend({
  provider: z.string(),
  reason: z.enum(["missing_auth", "invalid_auth"]),
});
export class AuthResolutionError extends Data.TaggedError("AuthResolutionError")<
  z.infer<typeof AuthFields>
> {}
const ProxyFields = MessageFields.extend({ url: z.string(), status: z.number().optional() });
export class ProxyModelsError extends Data.TaggedError("ProxyModelsError")<
  z.infer<typeof ProxyFields>
> {}
const BoundaryFields = Diagnostic.extend({
  message: z.string(),
  aborted: z.boolean().optional(),
  providerErrorName: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});
export class TransportFailure extends Data.TaggedError("TransportFailure")<
  z.infer<typeof BoundaryFields>
> {}
export class InvalidProviderData extends Data.TaggedError("InvalidProviderData")<
  z.infer<typeof BoundaryFields>
> {}

export type LlmError =
  | AgentFailure
  | APIError
  | LlmRunFailure
  | ModelResolutionError
  | AuthInvalidFileError
  | AuthResolutionError
  | ProxyModelsError
  | TransportFailure
  | InvalidProviderData;
