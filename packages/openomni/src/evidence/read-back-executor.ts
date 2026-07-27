import { WorkItem } from "@openomni/protocol";
import type {
  WorkerLedgerBinding,
  WorkerLedgerService,
} from "../dispatch/handlers/worker-work-item.js";
import { commitWorkerLedgerTransition, digest } from "../dispatch/handlers/worker-work-item.js";
import { digestObservedBody, isCompleteSuccess, loadReadBackUrl } from "./read-back-http.js";
import {
  ReadBackRequest,
  type ParsedReadBackRequest,
  type ReadBackRequestInput,
} from "./read-back-request.js";

export namespace ReadBackExecutor {
  export type Options = {
    allowPrivateNetwork?: boolean;
  };

  export async function execute(
    input: ReadBackRequestInput,
    options: Options = {},
  ): Promise<WorkItem.ReadBackCheck> {
    const request = ReadBackRequest.parse(input);
    switch (request.kind) {
      case "url_fetch":
        return executeUrlFetch(request, options);
      case "api_query":
        return executeApiQuery(request, options);
      case "citation_match":
        return executeCitationMatch(request, options);
    }
  }

  export async function record(
    ledger: WorkerLedgerService,
    binding: WorkerLedgerBinding,
    input: ReadBackRequestInput,
    options: Options = {},
  ): Promise<string> {
    const check = await execute(input, options);
    const evidenceRef = digest(check);
    await commitWorkerLedgerTransition(ledger, binding, {
      transitionId: "WI-07",
      command: "kernel.work.record_readback.v1",
      requestKey: `${binding.runId}:readback:${evidenceRef}`,
      evidenceRef,
      facts: check,
    });
    return evidenceRef;
  }
}

async function executeUrlFetch(
  request: Extract<ParsedReadBackRequest, { kind: "url_fetch" }>,
  options: ReadBackExecutor.Options,
): Promise<WorkItem.ReadBackCheck> {
  const result = await loadReadBackUrl(
    request.target,
    "GET",
    request.timeoutMs,
    request.maxBodyBytes,
    options.allowPrivateNetwork === true,
  );
  return WorkItem.ReadBackCheck.parse({
    kind: "url_fetch",
    target: request.target,
    passed: isCompleteSuccess(result),
    observedAt: Date.now(),
    statusCode: result.statusCode,
    contentDigest: digestObservedBody(result),
  });
}

async function executeApiQuery(
  request: Extract<ParsedReadBackRequest, { kind: "api_query" }>,
  options: ReadBackExecutor.Options,
): Promise<WorkItem.ReadBackCheck> {
  const result = await loadReadBackUrl(
    request.target,
    request.method,
    request.timeoutMs,
    request.maxBodyBytes,
    options.allowPrivateNetwork === true,
  );
  return WorkItem.ReadBackCheck.parse({
    kind: "api_query",
    target: request.target,
    method: request.method,
    passed: isCompleteSuccess(result),
    observedAt: Date.now(),
    statusCode: result.statusCode,
    responseDigest: request.method === "HEAD" ? undefined : digestObservedBody(result),
  });
}

async function executeCitationMatch(
  request: Extract<ParsedReadBackRequest, { kind: "citation_match" }>,
  options: ReadBackExecutor.Options,
): Promise<WorkItem.ReadBackCheck> {
  const result = await loadReadBackUrl(
    request.target,
    "GET",
    request.timeoutMs,
    request.maxBodyBytes,
    options.allowPrivateNetwork === true,
  );
  const matched = isCompleteSuccess(result) && result.body.includes(request.quotedText);
  return WorkItem.ReadBackCheck.parse({
    kind: "citation_match",
    target: request.target,
    quotedText: request.quotedText,
    matchedText: matched ? request.quotedText : undefined,
    passed: matched,
    observedAt: Date.now(),
    statusCode: result.statusCode,
  });
}
