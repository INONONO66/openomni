import { z } from "zod";
const HttpMethod = z.enum(["GET", "HEAD"]);
const HttpUrl = z.string().url().refine(isHttpUrl, "read-back target must use http or https");

const ReadBackBase = z.object({
  target: z.string().min(1),
  passed: z.boolean(),
  observedAt: z.number(),
  statusCode: z.number().int().min(100).max(599).optional(),
  matchedText: z.string().min(1).optional(),
});

const ReadBackRequestBase = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxBodyBytes: z.number().int().positive().default(1_000_000),
});

export const ReadBackRequest = z.discriminatedUnion("kind", [
  ReadBackRequestBase.extend({
    kind: z.literal("url_fetch"),
    target: HttpUrl,
  }),
  ReadBackRequestBase.extend({
    kind: z.literal("api_query"),
    target: HttpUrl,
    method: HttpMethod.default("GET"),
  }),
  ReadBackRequestBase.extend({
    kind: z.literal("citation_match"),
    target: HttpUrl,
    quotedText: z.string().min(1),
  }),
]);
export type ReadBackRequest = z.infer<typeof ReadBackRequest>;

export const ReadBackRequestEnvelope = z.object({
  claimIndex: z.number().int().nonnegative(),
  request: ReadBackRequest,
});
export type ReadBackRequestEnvelope = z.infer<typeof ReadBackRequestEnvelope>;

export const ReadBackCheck = z
  .discriminatedUnion("kind", [
    ReadBackBase.extend({
      kind: z.literal("url_fetch"),
      target: z.string().url(),
      contentDigest: z.string().min(1).optional(),
    }),
    ReadBackBase.extend({
      kind: z.literal("api_query"),
      method: z.string().min(1).default("GET"),
      responseDigest: z.string().min(1).optional(),
    }),
    ReadBackBase.extend({
      kind: z.literal("citation_match"),
      target: z.string().url(),
      quotedText: z.string().min(1),
    }),
  ])
  .superRefine((check, ctx) => {
    if (!check.passed) return;
    if (check.statusCode !== undefined && (check.statusCode < 200 || check.statusCode > 299)) {
      ctx.addIssue({
        code: "custom",
        message: "passed read-back HTTP status must be 2xx",
        path: ["statusCode"],
      });
    }
    if (check.kind === "citation_match" && check.matchedText === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "passed citation_match read-back requires matchedText",
        path: ["matchedText"],
      });
    }
  });
export type ReadBackCheck = z.infer<typeof ReadBackCheck>;

export const Evidence = z
  .object({
    id: z.string(),
    kind: z.enum(["test_result", "build_result", "review", "verification", "manual", "custom"]),
    description: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
    readBack: ReadBackCheck.optional(),
    createdAt: z.number(),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.readBack && evidence.passed !== evidence.readBack.passed) {
      ctx.addIssue({
        code: "custom",
        message: "readBack.passed must match evidence.passed",
        path: ["readBack", "passed"],
      });
    }
  });
export type Evidence = z.infer<typeof Evidence>;

export const ExecutorKind = z.enum([
  "internal_chat_agent",
  "connector_endpoint",
  "external_api",
  "a2a",
  "human_channel",
]);
export type ExecutorKind = z.infer<typeof ExecutorKind>;

export const CompletionReport = z.object({
  summary: z.string().min(1),
  claims: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  caveats: z.array(z.string().min(1)).default([]),
  followUps: z.array(z.string().min(1)).default([]),
});
export type CompletionReport = z.infer<typeof CompletionReport>;

function isHttpUrl(target: string): boolean {
  try {
    const protocol = new URL(target).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
