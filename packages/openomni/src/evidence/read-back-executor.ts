import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
  bodyDigest: string | undefined;
  complete: boolean;
};

class DisallowedNetworkTargetError extends Error {
  constructor(address: string) {
    super(`read-back target resolves to a private network address: ${address}`);
    this.name = "DisallowedNetworkTargetError";
  }
}

export namespace ReadBackExecutor {
  export type Request = z.input<typeof ReadBackRequest>;
  export type Options = {
    allowPrivateNetwork?: boolean;
  };

  export async function execute(
    input: Request,
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
    workItemHash: string,
    input: Request,
    options: Options = {},
  ): Promise<WorkItem.Info | undefined> {
    const check = await execute(input, options);
    return WorkItemStore.addReadBackEvidence(workItemHash, check);
  }
}

async function executeUrlFetch(
  request: Extract<ParsedReadBackRequest, { kind: "url_fetch" }>,
  options: ReadBackExecutor.Options,
): Promise<WorkItem.ReadBackCheck> {
  const result = await loadUrl(
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
  const result = await loadUrl(
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
  const result = await loadUrl(
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

async function loadUrl(
  target: string,
  method: z.infer<typeof HttpMethod>,
  timeoutMs: number,
  maxBodyBytes: number,
  allowPrivateNetwork: boolean,
): Promise<HttpResult> {
  try {
    await validateNetworkTarget(target, allowPrivateNetwork);
    const deadlineAt = Date.now() + timeoutMs;
    const response = await ky(target, {
      method,
      redirect: "manual",
      retry: 0,
      timeout: timeoutMs,
      throwHttpErrors: false,
      headers: { accept: "*/*" },
    });
    if (method === "HEAD") {
      return { statusCode: response.status, body: "", bodyDigest: undefined, complete: true };
    }
    const body = await readBody(response, maxBodyBytes, deadlineAt);
    return { statusCode: response.status, ...body };
  } catch (error) {
    if (error instanceof DisallowedNetworkTargetError) throw error;
    return { statusCode: undefined, body: "", bodyDigest: undefined, complete: false };
  }
}

async function readBody(
  response: Response,
  maxBodyBytes: number,
  deadlineAt: number,
): Promise<Pick<HttpResult, "body" | "bodyDigest" | "complete">> {
  const reader = response.body?.getReader();
  if (!reader) return { body: "", bodyDigest: digestBytes(new Uint8Array()), complete: true };

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        await reader.cancel();
        return { body: "", bodyDigest: undefined, complete: false };
      }
      const result = await readWithDeadline(() => reader.read(), remainingMs);
      if (result === "timeout") {
        await reader.cancel();
        return { body: "", bodyDigest: undefined, complete: false };
      }
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        return { body: "", bodyDigest: undefined, complete: false };
      }
      chunks.push(result.value);
    }
  } catch {
    return { body: "", bodyDigest: undefined, complete: false };
  }
  const bodyBytes = collectBytes(chunks, bytes);
  return { body: decode(bodyBytes), bodyDigest: digestBytes(bodyBytes), complete: true };
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

function collectBytes(chunks: Uint8Array[], bytes: number): Uint8Array {
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

function digestObservedBody(result: HttpResult): string | undefined {
  if (result.statusCode === undefined || !result.complete) return undefined;
  return result.bodyDigest;
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

async function validateNetworkTarget(target: string, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  const hostname = new URL(target).hostname;
  const directAddress = parseAddress(hostname);
  const addresses =
    directAddress === undefined
      ? (await lookup(hostname, { all: true, verbatim: true })).map((address) => address.address)
      : [directAddress];

  const blocked = addresses.find(isBlockedAddress);
  if (blocked !== undefined) {
    throw new DisallowedNetworkTargetError(blocked);
  }
}

function parseAddress(hostname: string): string | undefined {
  if (isIP(hostname) !== 0) return hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const address = hostname.slice(1, -1);
    if (isIP(address) !== 0) return address;
  }
  return undefined;
}

function isBlockedAddress(address: string): boolean {
  if (isIPv4Address(address)) return isBlockedIPv4(address);
  return isBlockedIPv6(address);
}

function isIPv4Address(address: string): boolean {
  return isIP(address) === 4;
}

function isBlockedIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [first, second] = octets;
  if (first === undefined || second === undefined) return true;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    const mappedAddress = normalized.slice("::ffff:".length);
    return isIPv4Address(mappedAddress) ? isBlockedIPv4(mappedAddress) : true;
  }
  const firstSegment = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  if (Number.isNaN(firstSegment)) return true;
  return (
    (firstSegment & 0xfe00) === 0xfc00 ||
    (firstSegment & 0xffc0) === 0xfe80 ||
    (firstSegment & 0xff00) === 0xff00
  );
}
