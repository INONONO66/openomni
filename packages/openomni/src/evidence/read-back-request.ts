import { WorkItem } from "@openomni/protocol";
import type { z } from "zod";

const DEFAULT_READ_BACK_TIMEOUT_MS = 10_000;

export const ReadBackRequest = WorkItem.ReadBackRequest.transform((request) => ({
  ...request,
  timeoutMs: request.timeoutMs ?? DEFAULT_READ_BACK_TIMEOUT_MS,
}));

export type ReadBackRequestInput = z.input<typeof WorkItem.ReadBackRequest>;
export type ParsedReadBackRequest = z.infer<typeof ReadBackRequest>;
export type ReadBackHttpMethod = Extract<ParsedReadBackRequest, { kind: "api_query" }>["method"];
