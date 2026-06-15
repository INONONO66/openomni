import { z } from "zod";
import { isHttpUrl } from "./http.js";

const HttpMethod = z.enum(["GET", "HEAD"]);
const HttpUrl = z.string().url().refine(isHttpUrl, "read-back target must use http or https");

export const Status = z.enum(["pending", "running", "blocked", "completed", "failed", "cancelled"]);
export type Status = z.infer<typeof Status>;

export const Blocker = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(["dependency", "error", "waiting_input", "external", "unknown"]),
  createdAt: z.number(),
  resolvedAt: z.number().optional(),
});
export type Blocker = z.infer<typeof Blocker>;

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

export const Outcome = z.enum(["adopted", "corrected", "redone", "ignored"]);
export type Outcome = z.infer<typeof Outcome>;

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

export const VerificationGate = z.object({
  automated: z
    .object({
      passed: z.boolean(),
      checks: z.array(
        z.object({
          name: z.string(),
          passed: z.boolean(),
          output: z.string().optional(),
        }),
      ),
    })
    .optional(),
  acceptance: z
    .object({
      passed: z.boolean(),
      criteria: z.array(
        z.object({
          criterion: z.string(),
          met: z.boolean(),
          evidence: z.string().optional(),
        }),
      ),
    })
    .optional(),
  review: z
    .object({
      passed: z.boolean(),
      reviewer: z.string(),
      recommendation: z.enum(["approve", "request_changes", "reject"]),
      comments: z.string().optional(),
    })
    .optional(),
});
export type VerificationGate = z.infer<typeof VerificationGate>;

export const Info = z.object({
  hash: z.string(),
  name: z.string(),
  sourceMessageId: z.string(),
  sourceChannel: z.string(),
  assigneeId: z.string().optional(),
  sessionId: z.string().optional(),
  originSessionId: z.string().min(1).optional(),
  workSessionId: z.string().min(1).optional(),
  workerRunId: z.string().min(1).optional(),
  executorKind: ExecutorKind.optional(),
  attempt: z.number().int().min(1).default(1),
  maxAttempts: z.number().int().min(1).optional(),
  timestamps: z.object({
    created: z.number(),
    updated: z.number(),
    started: z.number().optional(),
    completed: z.number().optional(),
    failed: z.number().optional(),
    cancelled: z.number().optional(),
    deadline: z.number().optional(),
  }),
  relations: z.object({
    parentHash: z.string().optional(),
    childHashes: z.array(z.string()).default([]),
    dependsOn: z.array(z.string()).default([]),
  }),
  intent: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  failureReason: z.string().optional(),
  blockers: z.array(Blocker).default([]),
  evidence: z.array(Evidence).default([]),
  completionReport: CompletionReport.optional(),
  verificationGate: VerificationGate.optional(),
  outcome: Outcome.optional(),
});
export type Info = z.infer<typeof Info>;
