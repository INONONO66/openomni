import { z } from "zod";

const DEFAULT_READ_BACK_TIMEOUT_MS = 10_000;
const DEFAULT_READ_BACK_MAX_BODY_BYTES = 1_000_000;

export const ReadBackHttpMethod = z.enum(["GET", "HEAD"]);

const HttpUrl = z.string().url().refine(isHttpUrl, "read-back target must use http or https");

const RequestBase = z.object({
  timeoutMs: z.number().int().positive().default(DEFAULT_READ_BACK_TIMEOUT_MS),
  maxBodyBytes: z.number().int().positive().default(DEFAULT_READ_BACK_MAX_BODY_BYTES),
});

export const ReadBackRequest = z.discriminatedUnion("kind", [
  RequestBase.extend({
    kind: z.literal("url_fetch"),
    target: HttpUrl,
  }),
  RequestBase.extend({
    kind: z.literal("api_query"),
    target: HttpUrl,
    method: ReadBackHttpMethod.default("GET"),
  }),
  RequestBase.extend({
    kind: z.literal("citation_match"),
    target: HttpUrl,
    quotedText: z.string().min(1),
  }),
]);

export type ReadBackRequestInput = z.input<typeof ReadBackRequest>;
export type ParsedReadBackRequest = z.infer<typeof ReadBackRequest>;
export type ReadBackHttpMethod = z.infer<typeof ReadBackHttpMethod>;

function isHttpUrl(target: string): boolean {
  const protocol = new URL(target).protocol;
  return protocol === "http:" || protocol === "https:";
}
