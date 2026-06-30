import { z } from "zod";
import { BusEvent } from "../bus/index.js";
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
      hash: z.string(),
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
      hash: z.string(),
      fields: z.array(z.string()),
    }),
  }),
  { visibility: "internal" },
);

const StatusChanged = BusEvent.define(
  "work_item.status_changed",
  BaseEvent.extend({
    payload: z.object({
      hash: z.string(),
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
      hash: z.string(),
      sessionId: z.string().optional(),
    }),
  }),
  { visibility: "llm_reason" },
);

const Failed = BusEvent.define(
  "work_item.failed",
  BaseEvent.extend({
    payload: z.object({
      hash: z.string(),
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
      hash: z.string(),
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
      hash: z.string(),
      sessionId: z.string().optional(),
    }),
  }),
  { visibility: "internal" },
);

export const Events = {
  Created,
  Updated,
  StatusChanged,
  Completed,
  Failed,
  OutcomeRecorded,
  Removed,
} as const;
