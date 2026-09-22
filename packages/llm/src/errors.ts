import { Data } from "effect";
import { z } from "zod";

const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
export class ForeignFailure extends Data.TaggedError("ForeignFailure")<z.infer<typeof Diagnostic>> {
  override get message(): string { return this.cause; }
}

const MessageFields = z.object({ message: z.string(), cause: z.string().optional() });
const ProviderFields = MessageFields.extend({
  providerErrorName: z.string().optional(),
  statusCode: z.number().optional(),
  isRetryable: z.boolean(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  responseBody: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  aborted: z.boolean().optional(),
  contextOverflow: z.boolean().optional(),
});
export class APIError extends Data.TaggedError("APIError")<z.infer<typeof ProviderFields>> {}

const UsageFields = z.object({
  inputTokens: z.number(), outputTokens: z.number(), reasoningTokens: z.number(),
  cacheReadTokens: z.number(), cacheWriteTokens: z.number(),
});
const RunFields = ProviderFields.partial({ isRetryable: true }).extend({
  provider: z.string().optional(),
  model: z.string().optional(),
  providerErrorName: z.string().optional(),
  retryAfterMs: z.number().nonnegative().optional(),
  usage: UsageFields,
  aborted: z.boolean(),
  contextOverflow: z.boolean(),
  visibleOutput: z.boolean(),
});
export class LlmRunFailure extends Data.TaggedError("LlmRunFailure")<z.infer<typeof RunFields>> {}

const ResolutionFields = MessageFields.extend({
  provider: z.string(), model: z.string(),
  reason: z.enum(["provider_not_found", "proxy_listing_failed", "model_not_found"]),
});
export class ModelResolutionError extends Data.TaggedError("ModelResolutionError")<z.infer<typeof ResolutionFields>> {}
const FileFields = MessageFields.extend({ path: z.string() });
export class AuthInvalidFileError extends Data.TaggedError("AuthInvalidFileError")<z.infer<typeof FileFields>> {}
const AuthFields = MessageFields.extend({ provider: z.string(), reason: z.enum(["missing_auth", "invalid_auth"]) });
export class AuthResolutionError extends Data.TaggedError("AuthResolutionError")<z.infer<typeof AuthFields>> {}
const ProxyFields = MessageFields.extend({ url: z.string(), status: z.number().optional() });
export class ProxyModelsError extends Data.TaggedError("ProxyModelsError")<z.infer<typeof ProxyFields>> {}
const BoundaryFields = Diagnostic.extend({ message: z.string(), aborted: z.boolean().optional(), providerErrorName: z.string().optional(), provider: z.string().optional(), model: z.string().optional() });
export class TransportFailure extends Data.TaggedError("TransportFailure")<z.infer<typeof BoundaryFields>> {}
export class InvalidProviderData extends Data.TaggedError("InvalidProviderData")<z.infer<typeof BoundaryFields>> {}

export type LlmError = ForeignFailure | APIError | LlmRunFailure | ModelResolutionError |
  AuthInvalidFileError | AuthResolutionError | ProxyModelsError | TransportFailure | InvalidProviderData;
