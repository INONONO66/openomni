import { z } from "zod";
import { AttemptTerminal } from "./attempt.js";
import { EpochMs } from "../time.js";
import {
  CompletionContract,
  CompletionFacts,
  CompletionReport,
  CompletionTerminalReceipt,
} from "./completion-admission.js";
import { criterionId } from "./hash.js";
const HttpMethod = z.enum(["GET", "HEAD"]);
const HttpUrl = z.string().url().refine(isHttpUrl, "read-back target must use http or https");

export const Status = z.enum(["pending", "running", "blocked", "completed", "failed", "cancelled"]);
export type Status = z.infer<typeof Status>;

export const Blocker = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(["dependency", "error", "waiting_input", "external", "unknown"]),
  createdAt: EpochMs,
  resolvedAt: EpochMs.optional(),
});
export type Blocker = z.infer<typeof Blocker>;

const ReadBackBase = z.object({
  target: z.string().min(1),
  passed: z.boolean(),
  observedAt: EpochMs,
  statusCode: z.number().int().min(100).max(599).optional(),
  matchedText: z.string().min(1).optional(),
});

const ReadBackRequestBase = z.object({
  timeoutMs: z.number().int().positive().optional(),
  // Omission must not be the most-permissive case (the old default EQUALLED
  // the 1 MB enforcement ceiling), but the limit is reject-not-truncate: an
  // over-cap body fails the whole check, so the default must still cover an
  // ordinary article page. 256 KiB holds both — explicit requests up to the
  // ceiling pass the worker-completion guard.
  maxBodyBytes: z.number().int().positive().default(262_144),
});

// Deliberately NOT unified with AppConnector's CompletionReport.readBackRequests
// mirror (app-connector/definition.ts): that schema carries unresolved target
// templates rendered by the server-side read-back builder, while this one
// validates fully resolved http(s) URLs.
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

export const ReadBackRequestEnvelope = z
  .object({
    claimIndex: z.number().int().nonnegative(),
    criterionIndex: z.number().int().nonnegative(),
    request: ReadBackRequest,
  })
  .strict();
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
    attempt: z.number().int().positive().optional(),
    basisRef: z.string().min(1).optional(),
    criterionId: z.string().min(1).optional(),
    createdAt: EpochMs,
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

const InfoShape = z.object({
  workItemId: z.string(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  sourceMessageId: z.string(),
  sourceChannel: z.string(),
  assigneeId: z.string().optional(),
  sessionId: z.string().optional(),
  originSessionId: z.string().min(1).optional(),
  workSessionId: z.string().min(1).optional(),
  workerRunId: z.string().min(1).optional(),
  executorKind: ExecutorKind.optional(),
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1).optional(),
  /**
   * #510 C2 attempt-identity watermark. `lastAttemptSeq` is the highest
   * attemptSeq allocated on this WorkItem's owner stream; the fact-seq ==
   * revision equation binds it to the stream's serialized append, so
   * attemptSeq is monotonic and never reused. `currentAttemptId` is the
   * most recently allocated attemptId — the retryOf lineage source for the
   * next allocation. Full attempt identity lives in the
   * `work_item.attempt_allocated` facts, not in this projection.
   */
  // DEFAULT-LIVE: pre-C2 rows persisted without the field; the builder also
  // states the birth watermark explicitly.
  lastAttemptSeq: z.number().int().nonnegative().default(0),
  currentAttemptId: z.string().min(1).optional(),
  /**
   * #510 D2b — the current attempt's terminal record, projected from
   * `work_item.attempt_finished` and cleared by the next allocation. This is
   * where the retired worker-run ledger's terminal state (outcome, endedAt,
   * error) lives after the cutover.
   */
  attemptTerminal: AttemptTerminal.optional(),
  timestamps: z.object({
    created: EpochMs,
    updated: EpochMs,
    started: EpochMs.optional(),
    completed: EpochMs.optional(),
    failed: EpochMs.optional(),
    cancelled: EpochMs.optional(),
    deadline: EpochMs.optional(),
  }),
  relations: z.object({
    parentId: z.string().optional(),
    childIds: z.array(z.string()),
    dependsOn: z.array(z.string()),
  }),
  intent: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().refine((value) => value.trim().length > 0)).min(1),
  changedFiles: z.array(z.string()),
  failureReason: z.string().optional(),
  blockers: z.array(Blocker),
  evidence: z.array(Evidence),
  completionContract: CompletionContract,
  completionFacts: CompletionFacts.refine((facts) => facts.criteria.length > 0),
  completionReport: CompletionReport.optional(),
  completionTerminalReceipt: CompletionTerminalReceipt.optional(),
  outcome: Outcome.optional(),
});

/**
 * #498 K2 read upcast — persisted `work_item.data` blobs (and the baked
 * `work_item.adopted` genesis snapshots) written before the identifier
 * rename carry the retired keys `hash` / `relations.parentHash` /
 * `relations.childHashes`. The VALUES are byte-identical (`wi_…` ids,
 * `criterion:` ids, `work:<id>` stream keys all embed the same strings);
 * only the keys map on read. Writers emit the new keys only. Mirrors the
 * ledger actor-kind upcast in ledger/streams.ts.
 */
function upcastInfoKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let upcast = record;
  if (upcast.workItemId === undefined && upcast.hash !== undefined) {
    const { hash, ...rest } = upcast;
    upcast = { ...rest, workItemId: hash };
  }
  const relations = upcast.relations;
  if (typeof relations === "object" && relations !== null && !Array.isArray(relations)) {
    const legacy = relations as Record<string, unknown>;
    const mapParent = legacy.parentId === undefined && legacy.parentHash !== undefined;
    const mapChildren = legacy.childIds === undefined && legacy.childHashes !== undefined;
    if (mapParent || mapChildren) {
      const { parentHash, childHashes, ...restRelations } = legacy;
      upcast = {
        ...(upcast === record ? { ...record } : upcast),
        relations: {
          ...restRelations,
          ...(mapParent ? { parentId: parentHash } : {}),
          ...(mapChildren ? { childIds: childHashes } : {}),
        },
      };
    }
  }
  return upcast;
}

export const Info = Object.assign(
  z.preprocess(upcastInfoKeys, InfoShape.superRefine(validateCompletionContract)),
  { shape: InfoShape.shape },
);
export type Info = z.infer<typeof InfoShape>;

function validateCompletionContract(item: z.infer<typeof InfoShape>, ctx: z.RefinementCtx): void {
  const criteria = item.completionFacts.criteria;
  if (criteria.length !== item.acceptanceCriteria.length) {
    ctx.addIssue({
      code: "custom",
      message: "completion criteria must match acceptance criteria",
      path: ["completionFacts", "criteria"],
    });
    return;
  }
  for (const [index, statement] of item.acceptanceCriteria.entries()) {
    const criterion = criteria[index];
    if (!criterion) continue;
    if (criterion.statement !== statement) {
      ctx.addIssue({
        code: "custom",
        message: "criterion statement must match acceptance criterion",
        path: ["completionFacts", "criteria", index, "statement"],
      });
    }
    if (criterion.id !== criterionId(item.workItemId, index, statement)) {
      ctx.addIssue({
        code: "custom",
        message: "criterion id must be deterministic for its WorkItem and acceptance criterion",
        path: ["completionFacts", "criteria", index, "id"],
      });
    }
    if (!criterion.required) {
      ctx.addIssue({
        code: "custom",
        message: "persisted acceptance criteria must be required",
        path: ["completionFacts", "criteria", index, "required"],
      });
    }
  }
}

// merged from http.ts (#453 hygiene: sub-30-LOC single-importer)
function isHttpUrl(target: string): boolean {
  try {
    const protocol = new URL(target).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
