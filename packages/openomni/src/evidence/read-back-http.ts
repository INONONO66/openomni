import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ReadBackHttpMethod } from "./read-back-request.js";
import { DisallowedNetworkTargetError, validateNetworkTarget } from "./read-back-network.js";

export type ReadBackHttpResult = {
  readonly statusCode: number | undefined;
  readonly body: string;
  readonly bodyDigest: string | undefined;
  readonly complete: boolean;
};

export async function loadReadBackUrl(
  target: string,
  method: ReadBackHttpMethod,
  timeoutMs: number,
  maxBodyBytes: number,
  allowPrivateNetwork: boolean,
  validateTarget: typeof validateNetworkTarget = validateNetworkTarget,
  requestResponse: typeof requestReadBackResponse = requestReadBackResponse,
  now: () => number = Date.now,
): Promise<ReadBackHttpResult> {
  try {
    const deadlineAt = now() + timeoutMs;
    const validated = await settleBeforeDeadline(
      validateTarget(target, allowPrivateNetwork),
      deadlineAt,
      now,
    );
    if (validated === undefined) return failedReadBackHttpResult();
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) return failedReadBackHttpResult();
    const response = await settleBeforeDeadline(
      requestResponse(validated, method, deadlineAt, now),
      deadlineAt,
      now,
    );
    if (response === undefined) return failedReadBackHttpResult();
    if (method === "HEAD") {
      response.resume();
      return { statusCode: response.statusCode, body: "", bodyDigest: undefined, complete: true };
    }
    const body = await readBody(response, maxBodyBytes, deadlineAt, now);
    return { statusCode: response.statusCode, ...body };
  } catch (error) {
    if (error instanceof DisallowedNetworkTargetError) throw error;
    return failedReadBackHttpResult();
  }
}

export function settleBeforeDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  now: () => number,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(() => resolve(undefined)),
      Math.max(0, deadlineAt - now()),
    );

    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      settle();
    }

    operation.then(
      (value) => finish(() => resolve(now() >= deadlineAt ? undefined : value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function digestObservedBody(result: ReadBackHttpResult): string | undefined {
  if (result.statusCode === undefined || !result.complete) return undefined;
  return result.bodyDigest;
}

export function isCompleteSuccess(result: ReadBackHttpResult): boolean {
  return (
    result.complete &&
    result.statusCode !== undefined &&
    result.statusCode >= 200 &&
    result.statusCode <= 299
  );
}

async function readBody(
  response: IncomingMessage,
  maxBodyBytes: number,
  deadlineAt: number,
  now: () => number,
): Promise<Pick<ReadBackHttpResult, "body" | "bodyDigest" | "complete">> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(incompleteBody()), Math.max(0, deadlineAt - now()));

    function finish(result: Pick<ReadBackHttpResult, "body" | "bodyDigest" | "complete">): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      response.destroy();
      resolve(result);
    }

    response.on("data", (chunk: string | Buffer) => {
      const bytesChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += bytesChunk.byteLength;
      if (bytes > maxBodyBytes) {
        finish(incompleteBody());
        return;
      }
      chunks.push(bytesChunk);
    });
    response.once("end", () => {
      if (now() >= deadlineAt) {
        finish(incompleteBody());
        return;
      }
      const bodyBytes = collectBytes(chunks, bytes);
      finish({ body: decode(bodyBytes), bodyDigest: digestBytes(bodyBytes), complete: true });
    });
    response.once("aborted", () => finish(incompleteBody()));
    response.once("error", () => finish(incompleteBody()));
  });
}

function requestReadBackResponse(
  target: Awaited<ReturnType<typeof validateNetworkTarget>>,
  method: ReadBackHttpMethod,
  deadlineAt: number,
  now: () => number,
): Promise<IncomingMessage | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = Math.max(0, deadlineAt - now());
    const options = createRequestOptions(target, method, timeoutMs);
    const finish = (response: IncomingMessage | undefined): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      resolve(response);
    };
    const request =
      target.url.protocol === "https:"
        ? httpsRequest({ ...options, servername: target.serverName }, (response) => {
            finish(response);
          })
        : httpRequest(options, (response) => {
            finish(response);
          });

    request.once("error", () => finish(undefined));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(undefined);
    });
    deadline = setTimeout(() => {
      request.destroy();
      finish(undefined);
    }, timeoutMs);
    request.end();
  });
}

function createRequestOptions(
  target: Awaited<ReturnType<typeof validateNetworkTarget>>,
  method: ReadBackHttpMethod,
  timeoutMs: number,
): RequestOptions {
  return {
    protocol: target.url.protocol,
    hostname: target.address,
    port: target.url.port,
    method,
    path: `${target.url.pathname}${target.url.search}`,
    timeout: timeoutMs,
    headers: {
      accept: "*/*",
      host: target.hostHeader,
    },
  };
}

function collectBytes(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function digestBytes(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function failedReadBackHttpResult(): ReadBackHttpResult {
  return { statusCode: undefined, body: "", bodyDigest: undefined, complete: false };
}

function incompleteBody(): Pick<ReadBackHttpResult, "body" | "bodyDigest" | "complete"> {
  return { body: "", bodyDigest: undefined, complete: false };
}
