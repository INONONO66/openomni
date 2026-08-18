import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import {
  CompletionDecision,
  CompletionRequest,
  CompletionTerminalReceipt,
} from "./completion-admission.js";
import { Outcome, Status } from "./schemas.js";

const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

const Created = BusEvent.define(
  "work_item.created",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      name: z.string(),
      sessionId: z.string().optional(),
      assigneeId: z.string().optional(),
    }),
  }),
  { visibility: "llm_reason" },
);

const Updated = BusEvent.define(
  "work_item.updated",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      fields: z.array(z.string()),
    }),
  }),
  { visibility: "internal" },
);

const StatusChanged = BusEvent.define(
  "work_item.status_changed",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      from: Status,
      to: Status,
    }),
  }),
  { visibility: "llm_reason" },
);

const Completed = BusEvent.define(
  "work_item.completed",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      sessionId: z.string().optional(),
    }),
  }),
  { visibility: "llm_reason" },
);

const CompletedV2 = BusEvent.define(
  "work_item.completed.v2",
  BaseEvent.extend({
    payload: CompletionTerminalReceipt.extend({
      sessionId: z.string().optional(),
    }),
  }),
  { visibility: "llm_reason" },
);

const CompletionRequested = BusEvent.define(
  "work.complete.requested",
  BaseEvent.extend({ payload: CompletionRequest }),
  { visibility: "internal" },
);

const CompletionAdmissionRecorded = BusEvent.define(
  "work_item.completion_admission_recorded",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      admissionId: z.string(),
      decision: CompletionDecision,
      recordedHead: z.number().int().positive(),
    }),
  }),
  { visibility: "llm_reason" },
);

const Failed = BusEvent.define(
  "work_item.failed",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      reason: z.string().optional(),
      sessionId: z.string().optional(),
    }),
  }),
  { visibility: "llm_reason" },
);

const OutcomeRecorded = BusEvent.define(
  "work_item.outcome_recorded",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      outcome: Outcome,
      sessionId: z.string().optional(),
    }),
  }),
  { visibility: "llm_reason" },
);

const Removed = BusEvent.define(
  "work_item.removed",
  BaseEvent.extend({
    payload: z.object({
      workItemId: z.string(),
      sessionId: z.string().optional(),
    }),
  }),
  { visibility: "internal" },
);

export const Events = {
  Created,
  Updated,
  StatusChanged,
  CompletionRequested,
  CompletionAdmissionRecorded,
  Completed,
  CompletedV2,
  Failed,
  OutcomeRecorded,
  Removed,
} as const;
