import { createHash } from "node:crypto";
import { WorkItem } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import ky from "ky";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;

const HttpMethod = z.enum(["GET", "HEAD"]);
const HttpUrl = z.string().url().refine(isHttpUrl, "read-back target must use http or https");

const RequestBase = z.object({
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  maxBodyBytes: z.number().int().positive().default(MAX_BODY_BYTES),
});

const ReadBackRequest = z.discriminatedUnion("kind", [
  RequestBase.extend({
    kind: z.literal("url_fetch"),
    target: HttpUrl,
  }),
  RequestBase.extend({
    kind: z.literal("api_query"),
    target: HttpUrl,
    method: HttpMethod.default("GET"),
  }),
  RequestBase.extend({
    kind: z.literal("citation_match"),
    target: HttpUrl,
    quotedText: z.string().min(1),
  }),
]);

type ParsedReadBackRequest = z.infer<typeof ReadBackRequest>;
type HttpResult = {
  statusCode: number | undefined;
  body: string;
  complete: boolean;
};

export namespace ReadBackExecutor {
  export type Request = z.input<typeof ReadBackRequest>;

  export async function execute(input: Request): Promise<WorkItem.ReadBackCheck> {
    const request = ReadBackRequest.parse(input);
    switch (request.kind) {
      case "url_fetch":
        return executeUrlFetch(request);
      case "api_query":
        return executeApiQuery(request);
      case "citation_match":
        return executeCitationMatch(request);
    }
  }

  export async function record(
    workItemHash: string,
    input: Request,
  ): Promise<WorkItem.Info | undefined> {
    const check = await execute(input);
    return WorkItemStore.addReadBackEvidence(workItemHash, check);
  }
}

async function executeUrlFetch(
  request: Extract<ParsedReadBackRequest, { kind: "url_fetch" }>,
): Promise<WorkItem.ReadBackCheck> {
  const result = await loadUrl(request.target, "GET", request.timeoutMs, request.maxBodyBytes);
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
): Promise<WorkItem.ReadBackCheck> {
  const result = await loadUrl(
    request.target,
    request.method,
    request.timeoutMs,
    request.maxBodyBytes,
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
): Promise<WorkItem.ReadBackCheck> {
  const result = await loadUrl(request.target, "GET", request.timeoutMs, request.maxBodyBytes);
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

async function loadUrl(
  target: string,
  method: z.infer<typeof HttpMethod>,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<HttpResult> {
  try {
    const deadlineAt = Date.now() + timeoutMs;
    const response = await ky(target, {
      method,
      retry: 0,
      timeout: timeoutMs,
      throwHttpErrors: false,
      headers: { accept: "*/*" },
    });
    if (method === "HEAD") {
      return { statusCode: response.status, body: "", complete: true };
    }
    const body = await readBody(response, maxBodyBytes, deadlineAt);
    return { statusCode: response.status, ...body };
  } catch {
    return { statusCode: undefined, body: "", complete: false };
  }
}

async function readBody(
  response: Response,
  maxBodyBytes: number,
  deadlineAt: number,
): Promise<Pick<HttpResult, "body" | "complete">> {
  const reader = response.body?.getReader();
  if (!reader) return { body: "", complete: true };

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        await reader.cancel();
        return { body: "", complete: false };
      }
      const result = await readWithDeadline(() => reader.read(), remainingMs);
      if (result === "timeout") {
        await reader.cancel();
        return { body: "", complete: false };
      }
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        return { body: "", complete: false };
      }
      chunks.push(result.value);
    }
  } catch {
    return { body: "", complete: false };
  }
  return { body: decode(chunks, bytes), complete: true };
}

async function readWithDeadline<T>(
  read: () => Promise<T>,
  remainingMs: number,
): Promise<T | "timeout"> {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function decode(chunks: Uint8Array[], bytes: number): string {
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function digest(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function digestObservedBody(result: HttpResult): string | undefined {
  if (result.statusCode === undefined || !result.complete) return undefined;
  return digest(result.body);
}

function isCompleteSuccess(result: HttpResult): boolean {
  return (
    result.complete &&
    result.statusCode !== undefined &&
    result.statusCode >= 200 &&
    result.statusCode <= 299
  );
}

function isHttpUrl(target: string): boolean {
  const protocol = new URL(target).protocol;
  return protocol === "http:" || protocol === "https:";
}
